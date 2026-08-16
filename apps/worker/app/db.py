from __future__ import annotations

import json
from typing import Any

import aiosqlite

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  owner_email TEXT NOT NULL,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  banner_url TEXT,
  is_live INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_email, slug)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  channel_slug TEXT,
  source_url TEXT,
  title TEXT,
  local_path TEXT,
  cut_path TEXT,
  error TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS user_settings (
  email TEXT PRIMARY KEY,
  theme TEXT NOT NULL DEFAULT 'dark',
  youtube_client_id TEXT NOT NULL DEFAULT '',
  youtube_client_secret TEXT NOT NULL DEFAULT '',
  youtube_refresh_token TEXT NOT NULL DEFAULT '',
  youtube_oauth_state TEXT NOT NULL DEFAULT '',
  youtube_privacy_default TEXT NOT NULL DEFAULT 'unlisted',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


async def ensure_admin_seed(db: aiosqlite.Connection) -> None:
    email = (settings.admin_email or "").strip().lower()
    if not email:
        return
    cur = await db.execute("SELECT email, role FROM allowed_emails WHERE email = ?", (email,))
    row = await cur.fetchone()
    if row is None:
        await db.execute(
            "INSERT INTO allowed_emails(email, role, display_name, created_by) VALUES(?, 'admin', ?, ?)",
            (email, "Admin", "system"),
        )
        await db.commit()
    elif row["role"] != "admin":
        await db.execute(
            "UPDATE allowed_emails SET role = 'admin' WHERE email = ?",
            (email,),
        )
        await db.commit()


async def list_allowed_emails(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    cur = await db.execute(
        "SELECT email, role, display_name, created_at, created_by FROM allowed_emails ORDER BY role DESC, email ASC"
    )
    return [dict(r) for r in await cur.fetchall()]


async def get_allowed_email(db: aiosqlite.Connection, email: str) -> dict[str, Any] | None:
    email = email.strip().lower()
    cur = await db.execute(
        "SELECT email, role, display_name, created_at, created_by FROM allowed_emails WHERE email = ?",
        (email,),
    )
    row = await cur.fetchone()
    return dict(row) if row else None


async def add_allowed_email(
    db: aiosqlite.Connection,
    *,
    email: str,
    role: str = "user",
    created_by: str | None = None,
) -> dict[str, Any]:
    email = email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise ValueError("Geçersiz e-posta")
    if role not in {"admin", "user"}:
        role = "user"
    # Env admin is always admin
    if email == settings.admin_email.strip().lower():
        role = "admin"
    await db.execute(
        """
        INSERT INTO allowed_emails(email, role, created_by)
        VALUES(?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          role = excluded.role,
          created_by = COALESCE(excluded.created_by, allowed_emails.created_by)
        """,
        (email, role, created_by),
    )
    await db.commit()
    row = await get_allowed_email(db, email)
    assert row is not None
    return row


async def remove_allowed_email(db: aiosqlite.Connection, email: str) -> bool:
    email = email.strip().lower()
    if email == settings.admin_email.strip().lower():
        raise ValueError("Ana yönetici silinemez")
    row = await get_allowed_email(db, email)
    if not row:
        return False
    if row["role"] == "admin":
        cur = await db.execute(
            "SELECT COUNT(*) AS n FROM allowed_emails WHERE role = 'admin'"
        )
        n = int((await cur.fetchone())["n"])
        if n <= 1:
            raise ValueError("Son yönetici silinemez")
    cur = await db.execute("DELETE FROM allowed_emails WHERE email = ?", (email,))
    await db.commit()
    return cur.rowcount > 0


async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(settings.db_path)
    db.row_factory = aiosqlite.Row
    await db.executescript(SCHEMA)
    await db.commit()
    await ensure_admin_seed(db)
    await migrate_legacy_youtube_to_admin(db)
    await migrate_ownership(db)
    return db


def row_to_dict(row: aiosqlite.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return dict(row)


async def get_setting(db: aiosqlite.Connection, key: str, default: str | None = None) -> str | None:
    cur = await db.execute("SELECT value FROM settings WHERE key = ?", (key,))
    row = await cur.fetchone()
    if row is None:
        return default
    return row["value"]


async def set_setting(db: aiosqlite.Connection, key: str, value: str) -> None:
    await db.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    await db.commit()


async def get_all_settings(db: aiosqlite.Connection) -> dict[str, Any]:
    """Legacy global settings (non-secret app defaults only)."""
    cur = await db.execute("SELECT key, value FROM settings")
    rows = await cur.fetchall()
    out: dict[str, Any] = {}
    for row in rows:
        key = row["key"]
        # Never expose legacy shared YouTube secrets via global settings
        if key.startswith("youtube_"):
            continue
        out[key] = row["value"]
    defaults = {
        "theme": "dark",
        "worker_public_url": settings.public_base_url,
    }
    for k, v in defaults.items():
        out.setdefault(k, v)
    return out


def _mask_user_settings(row: dict[str, Any]) -> dict[str, Any]:
    secret = row.get("youtube_client_secret") or ""
    refresh = row.get("youtube_refresh_token") or ""
    return {
        "theme": row.get("theme") or "dark",
        "worker_public_url": settings.public_base_url,
        "youtube_client_id": row.get("youtube_client_id") or "",
        "youtube_client_secret": "***" if secret else "",
        "youtube_client_secret_set": bool(secret),
        "youtube_refresh_token_set": bool(refresh),
        "youtube_privacy_default": row.get("youtube_privacy_default") or "unlisted",
    }


async def ensure_user_settings(db: aiosqlite.Connection, email: str) -> dict[str, Any]:
    email = email.strip().lower()
    cur = await db.execute("SELECT * FROM user_settings WHERE email = ?", (email,))
    row = await cur.fetchone()
    if row:
        return dict(row)
    await db.execute(
        "INSERT INTO user_settings(email) VALUES(?)",
        (email,),
    )
    await db.commit()
    cur = await db.execute("SELECT * FROM user_settings WHERE email = ?", (email,))
    row = await cur.fetchone()
    assert row is not None
    return dict(row)


async def get_user_settings(db: aiosqlite.Connection, email: str) -> dict[str, Any]:
    return await ensure_user_settings(db, email)


async def get_user_settings_public(db: aiosqlite.Connection, email: str) -> dict[str, Any]:
    row = await ensure_user_settings(db, email)
    return _mask_user_settings(row)


async def update_user_settings(
    db: aiosqlite.Connection,
    email: str,
    patch: dict[str, Any],
) -> dict[str, Any]:
    await ensure_user_settings(db, email)
    allowed = {
        "theme",
        "youtube_client_id",
        "youtube_client_secret",
        "youtube_refresh_token",
        "youtube_oauth_state",
        "youtube_privacy_default",
    }
    sets: list[str] = []
    values: list[Any] = []
    for key, value in patch.items():
        if key not in allowed or value is None:
            continue
        sets.append(f"{key} = ?")
        values.append(str(value))
    if not sets:
        return await get_user_settings(db, email)
    sets.append("updated_at = datetime('now')")
    values.append(email.strip().lower())
    await db.execute(
        f"UPDATE user_settings SET {', '.join(sets)} WHERE email = ?",
        values,
    )
    await db.commit()
    return await get_user_settings(db, email)


async def migrate_legacy_youtube_to_admin(db: aiosqlite.Connection) -> None:
    """One-time: move shared settings youtube_* into ADMIN_EMAIL user_settings."""
    admin = (settings.admin_email or "").strip().lower()
    if not admin:
        return
    keys = (
        "youtube_client_id",
        "youtube_client_secret",
        "youtube_refresh_token",
        "youtube_oauth_state",
        "youtube_privacy_default",
    )
    legacy: dict[str, str] = {}
    for key in keys:
        val = await get_setting(db, key)
        if val:
            legacy[key] = val
    if not legacy:
        return

    row = await ensure_user_settings(db, admin)
    patch: dict[str, Any] = {}
    for key, val in legacy.items():
        if not (row.get(key) or "").strip():
            patch[key] = val
    theme = await get_setting(db, "theme")
    if theme and not (row.get("theme") or "").strip():
        patch["theme"] = theme
    if patch:
        await update_user_settings(db, admin, patch)

    for key in keys:
        await db.execute("DELETE FROM settings WHERE key = ?", (key,))
    await db.commit()


async def migrate_ownership(db: aiosqlite.Connection) -> None:
    """Ensure channels/jobs are scoped by owner_email; legacy rows → admin."""
    admin = (settings.admin_email or "").strip().lower() or "admin@localhost"

    cur = await db.execute("PRAGMA table_info(channels)")
    channel_cols = {str(r[1]) for r in await cur.fetchall()}
    if "owner_email" not in channel_cols:
        await db.execute(
            """
            CREATE TABLE channels_v2 (
              owner_email TEXT NOT NULL,
              slug TEXT NOT NULL,
              display_name TEXT NOT NULL,
              avatar_url TEXT,
              banner_url TEXT,
              is_live INTEGER NOT NULL DEFAULT 0,
              raw_json TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (owner_email, slug)
            )
            """
        )
        await db.execute(
            """
            INSERT INTO channels_v2 (
              owner_email, slug, display_name, avatar_url, banner_url, is_live, raw_json, created_at
            )
            SELECT ?, slug, display_name, avatar_url, banner_url, is_live, raw_json, created_at
            FROM channels
            """,
            (admin,),
        )
        await db.execute("DROP TABLE channels")
        await db.execute("ALTER TABLE channels_v2 RENAME TO channels")
        await db.commit()
    else:
        await db.execute(
            "UPDATE channels SET owner_email = ? WHERE owner_email IS NULL OR trim(owner_email) = ''",
            (admin,),
        )
        await db.commit()

    cur = await db.execute("PRAGMA table_info(jobs)")
    job_cols = {str(r[1]) for r in await cur.fetchall()}
    if "owner_email" not in job_cols:
        await db.execute("ALTER TABLE jobs ADD COLUMN owner_email TEXT NOT NULL DEFAULT ''")
        await db.commit()
    await db.execute(
        "UPDATE jobs SET owner_email = ? WHERE owner_email IS NULL OR trim(owner_email) = ''",
        (admin,),
    )
    await db.commit()


async def list_channels(db: aiosqlite.Connection, owner_email: str) -> list[dict[str, Any]]:
    owner = owner_email.strip().lower()
    cur = await db.execute(
        "SELECT * FROM channels WHERE owner_email = ? ORDER BY created_at ASC",
        (owner,),
    )
    rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def upsert_channel(
    db: aiosqlite.Connection,
    data: dict[str, Any],
    *,
    owner_email: str,
) -> dict[str, Any]:
    owner = owner_email.strip().lower()
    slug = data["slug"]
    await db.execute(
        """
        INSERT INTO channels(owner_email, slug, display_name, avatar_url, banner_url, is_live, raw_json)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_email, slug) DO UPDATE SET
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          banner_url = excluded.banner_url,
          is_live = excluded.is_live,
          raw_json = excluded.raw_json
        """,
        (
            owner,
            slug,
            data["display_name"],
            data.get("avatar_url"),
            data.get("banner_url"),
            1 if data.get("is_live") else 0,
            json.dumps(data.get("raw") or {}),
        ),
    )
    await db.commit()
    cur = await db.execute(
        "SELECT * FROM channels WHERE owner_email = ? AND slug = ?",
        (owner, slug),
    )
    row = await cur.fetchone()
    return dict(row)


async def get_channel(
    db: aiosqlite.Connection,
    slug: str,
    *,
    owner_email: str,
) -> dict[str, Any] | None:
    owner = owner_email.strip().lower()
    cur = await db.execute(
        "SELECT * FROM channels WHERE owner_email = ? AND slug = ?",
        (owner, slug),
    )
    return row_to_dict(await cur.fetchone())


async def delete_channel(
    db: aiosqlite.Connection,
    slug: str,
    *,
    owner_email: str,
) -> bool:
    owner = owner_email.strip().lower()
    cur = await db.execute(
        "DELETE FROM channels WHERE owner_email = ? AND slug = ?",
        (owner, slug),
    )
    await db.commit()
    return cur.rowcount > 0


async def create_job(db: aiosqlite.Connection, job: dict[str, Any]) -> dict[str, Any]:
    owner = (job.get("owner_email") or "").strip().lower()
    await db.execute(
        """
        INSERT INTO jobs(
          id, owner_email, kind, status, progress, channel_slug, source_url,
          title, local_path, cut_path, error, meta_json
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job["id"],
            owner,
            job["kind"],
            job["status"],
            job.get("progress", 0),
            job.get("channel_slug"),
            job.get("source_url"),
            job.get("title"),
            job.get("local_path"),
            job.get("cut_path"),
            job.get("error"),
            json.dumps(job.get("meta") or {}),
        ),
    )
    await db.commit()
    return await get_job(db, job["id"])  # type: ignore[return-value]


async def update_job(db: aiosqlite.Connection, job_id: str, **fields: Any) -> dict[str, Any] | None:
    if not fields:
        return await get_job(db, job_id)
    allowed = {
        "status",
        "progress",
        "local_path",
        "cut_path",
        "error",
        "title",
        "meta_json",
        "source_url",
        "channel_slug",
        "owner_email",
    }
    sets: list[str] = []
    values: list[Any] = []
    for key, value in fields.items():
        if key == "meta":
            key = "meta_json"
            value = json.dumps(value)
        if key not in allowed:
            continue
        sets.append(f"{key} = ?")
        values.append(value)
    sets.append("updated_at = datetime('now')")
    values.append(job_id)
    await db.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", values)
    await db.commit()
    return await get_job(db, job_id)


async def get_job(db: aiosqlite.Connection, job_id: str) -> dict[str, Any] | None:
    cur = await db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
    row = await cur.fetchone()
    if row is None:
        return None
    data = dict(row)
    try:
        data["meta"] = json.loads(data.pop("meta_json") or "{}")
    except json.JSONDecodeError:
        data["meta"] = {}
        data.pop("meta_json", None)
    return data


async def get_job_for_owner(
    db: aiosqlite.Connection,
    job_id: str,
    owner_email: str,
) -> dict[str, Any] | None:
    job = await get_job(db, job_id)
    if not job:
        return None
    if (job.get("owner_email") or "").strip().lower() != owner_email.strip().lower():
        return None
    return job


async def list_jobs(
    db: aiosqlite.Connection,
    owner_email: str,
    limit: int = 40,
) -> list[dict[str, Any]]:
    owner = owner_email.strip().lower()
    cur = await db.execute(
        """
        SELECT * FROM jobs
        WHERE owner_email = ?
        ORDER BY datetime(updated_at) DESC
        LIMIT ?
        """,
        (owner, max(1, min(limit, 100))),
    )
    rows = await cur.fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        data = dict(row)
        try:
            data["meta"] = json.loads(data.pop("meta_json") or "{}")
        except json.JSONDecodeError:
            data["meta"] = {}
            data.pop("meta_json", None)
        out.append(data)
    return out


async def delete_job(
    db: aiosqlite.Connection,
    job_id: str,
    *,
    owner_email: str | None = None,
) -> bool:
    if owner_email:
        cur = await db.execute(
            "DELETE FROM jobs WHERE id = ? AND owner_email = ?",
            (job_id, owner_email.strip().lower()),
        )
    else:
        cur = await db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    await db.commit()
    return cur.rowcount > 0
