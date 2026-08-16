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
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  banner_url TEXT,
  is_live INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
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
"""


async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(settings.db_path)
    db.row_factory = aiosqlite.Row
    await db.executescript(SCHEMA)
    await db.commit()
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
    cur = await db.execute("SELECT key, value FROM settings")
    rows = await cur.fetchall()
    out: dict[str, Any] = {}
    for row in rows:
        key = row["key"]
        value = row["value"]
        if key in {"youtube_client_secret", "youtube_refresh_token"} and value:
            out[key] = "***"
            out[f"{key}_set"] = True
        else:
            out[key] = value
            if key.endswith("_secret") or key.endswith("_token"):
                out[f"{key}_set"] = bool(value)
    defaults = {
        "theme": "dark",
        "worker_public_url": settings.public_base_url,
        "youtube_client_id": "",
        "youtube_privacy_default": "unlisted",
    }
    for k, v in defaults.items():
        out.setdefault(k, v)
    return out


async def list_channels(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    cur = await db.execute("SELECT * FROM channels ORDER BY created_at ASC")
    rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def upsert_channel(db: aiosqlite.Connection, data: dict[str, Any]) -> dict[str, Any]:
    await db.execute(
        """
        INSERT INTO channels(slug, display_name, avatar_url, banner_url, is_live, raw_json)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          banner_url = excluded.banner_url,
          is_live = excluded.is_live,
          raw_json = excluded.raw_json
        """,
        (
            data["slug"],
            data["display_name"],
            data.get("avatar_url"),
            data.get("banner_url"),
            1 if data.get("is_live") else 0,
            json.dumps(data.get("raw") or {}),
        ),
    )
    await db.commit()
    cur = await db.execute("SELECT * FROM channels WHERE slug = ?", (data["slug"],))
    row = await cur.fetchone()
    return dict(row)


async def get_channel(db: aiosqlite.Connection, slug: str) -> dict[str, Any] | None:
    cur = await db.execute("SELECT * FROM channels WHERE slug = ?", (slug,))
    return row_to_dict(await cur.fetchone())


async def delete_channel(db: aiosqlite.Connection, slug: str) -> bool:
    cur = await db.execute("DELETE FROM channels WHERE slug = ?", (slug,))
    await db.commit()
    return cur.rowcount > 0


async def create_job(db: aiosqlite.Connection, job: dict[str, Any]) -> dict[str, Any]:
    await db.execute(
        """
        INSERT INTO jobs(id, kind, status, progress, channel_slug, source_url, title, local_path, cut_path, error, meta_json)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job["id"],
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


async def list_jobs(db: aiosqlite.Connection, limit: int = 40) -> list[dict[str, Any]]:
    cur = await db.execute(
        "SELECT * FROM jobs ORDER BY datetime(updated_at) DESC LIMIT ?",
        (max(1, min(limit, 100)),),
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


async def delete_job(db: aiosqlite.Connection, job_id: str) -> bool:
    cur = await db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    await db.commit()
    return cur.rowcount > 0
