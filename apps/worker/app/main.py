from __future__ import annotations

import asyncio
import base64
import re
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import db as database
from .config import settings
from .ffmpeg_util import (
    FFmpegError,
    apply_overlays,
    cut_media,
    ensure_clip_duration,
    overlay_output_duration,
    prepare_for_youtube,
    probe_duration,
)
from .kick import (
    KickError,
    ensure_live_playlist,
    fetch_channel,
    fetch_chat_around,
    fetch_clip_playback,
    fetch_clips,
    fetch_hls_bytes,
    fetch_live_playback,
    fetch_vod_playback,
    fetch_vods,
    normalize_vod_playlist,
    parse_vod_uuid,
    pick_media_playlist,
    playlist_duration_seconds,
    resolve_chat_context,
)
from .live_buffer import ring_status, ring_window_path, start_live_ring, stop_live_ring
from .login_auth import (
    LoginAuthError,
    build_login_auth_url,
    exchange_login_code,
    fetch_google_user,
)
from .models import (
    AllowedEmailCreate,
    ChannelAssetCreate,
    ChannelCreate,
    CutRequest,
    DownloadRequest,
    JobOut,
    LiveOpenRequest,
    SettingsUpdate,
    TimelineUpdate,
    YoutubeUploadRequest,
    parse_kick_slug,
)
from .session_auth import (
    COOKIE_NAME,
    SessionUser,
    normalize_email,
    session_cookie_kwargs,
    sign_session,
    verify_session,
)
from .stream import DownloadError, download_segment
from .thumb_assets import (
    MAX_ASSETS_PER_CHANNEL,
    asset_path,
    parse_image_data_url,
    safe_owner,
    safe_slug,
)
from .youtube_util import (
    YoutubeError,
    build_auth_url,
    exchange_code_for_tokens,
    new_oauth_state,
    set_thumbnail,
    upload_video,
    wait_until_processed,
)

app = FastAPI(title="CutMuck Worker", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin, "http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serialize cut/encode/upload so a 6c/12GB box stays saturated on one job
_heavy_job_sem = asyncio.Semaphore(max(1, int(settings.heavy_job_slots)))
_ACTIVE_YT = frozenset({"queued", "exporting", "uploading", "cutting", "processing"})


def _is_public_path(path: str) -> bool:
    if path == "/health" or path == "/auth/me":
        return True
    if path.startswith("/auth/login/"):
        return True
    return False


def _google_login_creds() -> tuple[str, str]:
    cid = (settings.google_client_id or "").strip()
    secret = (settings.google_client_secret or "").strip()
    return cid, secret


def current_user(request: Request) -> SessionUser:
    user = getattr(request.state, "user", None)
    if not isinstance(user, SessionUser):
        raise HTTPException(401, "Giriş gerekli")
    return user


def require_admin(request: Request) -> SessionUser:
    user = current_user(request)
    if user.role != "admin":
        raise HTTPException(403, "Bu işlem için yönetici yetkisi gerekli")
    return user


async def owned_job(db: Any, request: Request, job_id: str) -> dict[str, Any]:
    user = current_user(request)
    job = await database.get_job_for_owner(db, job_id, user.email)
    if not job:
        raise HTTPException(404, "Job bulunamadı")
    return job


@app.middleware("http")
async def auth_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    path = request.url.path
    if _is_public_path(path):
        return await call_next(request)

    token = request.cookies.get(COOKIE_NAME)
    session = verify_session(token)
    if not session:
        return JSONResponse({"detail": "Giriş gerekli"}, status_code=401)

    db = await database.get_db()
    try:
        row = await database.get_allowed_email(db, session.email)
    finally:
        await db.close()

    if not row:
        return JSONResponse(
            {"detail": "Bu Google hesabının erişim izni yok"},
            status_code=403,
        )

    request.state.user = SessionUser(
        email=row["email"],
        role=row["role"] if row["role"] in {"admin", "user"} else "user",
        name=session.name,
        picture=session.picture,
    )
    return await call_next(request)


app.mount("/media", StaticFiles(directory=str(settings.media_dir)), name="media")


def job_urls(job: dict[str, Any]) -> JobOut:
    media_url = None
    cut_url = None
    stream_url = None
    cut_size = None
    meta = job.get("meta") or {}
    if job.get("local_path"):
        name = Path(job["local_path"]).name
        media_url = f"/media/{quote(name)}"
    if job.get("cut_path"):
        name = Path(job["cut_path"]).name
        cut_url = f"/media/{quote(name)}"
        try:
            cut_size = Path(job["cut_path"]).stat().st_size
        except OSError:
            cut_size = None
    if meta.get("hls_url") or job.get("source_url") or meta.get("mode") == "live":
        stream_url = f"/jobs/{job['id']}/stream.m3u8"
    return JobOut(
        id=job["id"],
        kind=job["kind"],
        status=job["status"],
        progress=float(job.get("progress") or 0),
        channel_slug=job.get("channel_slug"),
        source_url=job.get("source_url"),
        title=job.get("title"),
        local_path=job.get("local_path"),
        cut_path=job.get("cut_path"),
        error=job.get("error"),
        meta=meta,
        media_url=media_url,
        cut_url=cut_url,
        stream_url=stream_url,
        cut_size_bytes=cut_size,
        updated_at=job.get("updated_at"),
    )


def _b64url(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def _unb64url(value: str) -> str:
    pad = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + pad).decode("utf-8")


def _proxy_seg(abs_url: str, *, live: bool = False) -> str:
    # Browser talks to Next (/api/...), which proxies to the worker.
    q = f"u={_b64url(abs_url)}"
    if live:
        q += "&live=1"
    return f"/api/hls/seg?{q}"


def _rewrite_playlist(content: str, playlist_url: str, *, as_vod: bool = False, live: bool = False) -> str:
    base = playlist_url.rsplit("/", 1)[0] + "/"
    if live:
        content = ensure_live_playlist(content)
    elif as_vod:
        content = normalize_vod_playlist(content)
    lines: list[str] = []
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            if 'URI="' in raw:

                def repl(match: re.Match[str]) -> str:
                    abs_uri = urljoin(base, match.group(1))
                    return f'URI="{_proxy_seg(abs_uri, live=live)}"'

                lines.append(re.sub(r'URI="([^"]+)"', repl, raw))
            else:
                lines.append(raw)
            continue
        abs_url = urljoin(base, line)
        lines.append(_proxy_seg(abs_url, live=live))
    return "\n".join(lines) + "\n"


@app.on_event("startup")
async def startup() -> None:
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    db = await database.get_db()
    await db.close()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "cutmuck-worker"}


@app.get("/auth/me")
async def auth_me(request: Request) -> dict[str, Any]:
    token = request.cookies.get(COOKIE_NAME)
    session = verify_session(token)
    if not session:
        return {"authenticated": False}

    db = await database.get_db()
    try:
        row = await database.get_allowed_email(db, session.email)
    finally:
        await db.close()

    if not row:
        return {"authenticated": False, "reason": "not_allowed"}

    return {
        "authenticated": True,
        "email": row["email"],
        "role": row["role"],
        "is_admin": row["role"] == "admin",
        "name": session.name,
        "picture": session.picture,
        "login_redirect_uri": f"{settings.web_origin.rstrip('/')}/api/auth/login/callback",
    }


@app.get("/auth/login/start")
async def login_start(request: Request) -> dict[str, str]:
    client_id, client_secret = _google_login_creds()
    if not client_id or not client_secret:
        raise HTTPException(
            503,
            "Google giriş ayarları eksik. Sunucu .env içinde GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET gerekli.",
        )
    redirect_uri = f"{settings.web_origin.rstrip('/')}/api/auth/login/callback"
    state = new_oauth_state()
    db = await database.get_db()
    try:
        await database.set_setting(db, "login_oauth_state", state)
    finally:
        await db.close()
    auth_url = build_login_auth_url(
        client_id=client_id,
        redirect_uri=redirect_uri,
        state=state,
    )
    return {"auth_url": auth_url, "redirect_uri": redirect_uri}


@app.get("/auth/login/callback")
async def login_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    origin = settings.web_origin.rstrip("/")
    if error:
        return RedirectResponse(f"{origin}/?login=error&reason={quote(error)}")
    if not code:
        return RedirectResponse(f"{origin}/?login=error&reason=missing_code")

    client_id, client_secret = _google_login_creds()
    if not client_id or not client_secret:
        return RedirectResponse(f"{origin}/?login=error&reason=missing_credentials")

    redirect_uri = f"{origin}/api/auth/login/callback"
    db = await database.get_db()
    try:
        saved_state = await database.get_setting(db, "login_oauth_state")
        if not saved_state or not state or saved_state != state:
            return RedirectResponse(f"{origin}/?login=error&reason=state_mismatch")

        try:
            tokens = await asyncio.to_thread(
                exchange_login_code,
                client_id=client_id,
                client_secret=client_secret,
                redirect_uri=redirect_uri,
                code=code,
            )
            profile = await asyncio.to_thread(
                fetch_google_user,
                str(tokens["access_token"]),
            )
        except LoginAuthError as exc:
            return RedirectResponse(f"{origin}/?login=error&reason={quote(str(exc))}")

        email = normalize_email(profile["email"])
        row = await database.get_allowed_email(db, email)
        if not row:
            return RedirectResponse(f"{origin}/?login=denied")

        user = SessionUser(
            email=row["email"],
            role=row["role"] if row["role"] in {"admin", "user"} else "user",
            name=str(profile.get("name") or ""),
            picture=str(profile.get("picture") or ""),
        )
        if profile.get("name"):
            await db.execute(
                "UPDATE allowed_emails SET display_name = ? WHERE email = ?",
                (profile["name"], email),
            )
            await db.commit()

        resp = RedirectResponse(f"{origin}/?login=ok")
        resp.set_cookie(**session_cookie_kwargs(sign_session(user)))
        return resp
    finally:
        await db.close()


@app.post("/auth/logout")
async def auth_logout() -> Response:
    resp = JSONResponse({"ok": True})
    resp.set_cookie(**session_cookie_kwargs("", clear=True))
    return resp


@app.get("/auth/users")
async def auth_users_list(request: Request) -> list[dict[str, Any]]:
    require_admin(request)
    db = await database.get_db()
    try:
        return await database.list_allowed_emails(db)
    finally:
        await db.close()


@app.post("/auth/users")
async def auth_users_add(request: Request, body: AllowedEmailCreate) -> dict[str, Any]:
    admin = require_admin(request)
    db = await database.get_db()
    try:
        try:
            return await database.add_allowed_email(
                db,
                email=body.email,
                role=body.role,
                created_by=admin.email,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    finally:
        await db.close()


@app.delete("/auth/users/{email}")
async def auth_users_remove(request: Request, email: str) -> dict[str, bool]:
    require_admin(request)
    db = await database.get_db()
    try:
        try:
            ok = await database.remove_allowed_email(db, email)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not ok:
            raise HTTPException(404, "Kullanıcı bulunamadı")
        return {"ok": True}
    finally:
        await db.close()


@app.get("/settings")
async def get_settings(request: Request) -> dict[str, Any]:
    user = current_user(request)
    db = await database.get_db()
    try:
        return await database.get_user_settings_public(db, user.email)
    finally:
        await db.close()


@app.put("/settings")
async def put_settings(request: Request, body: SettingsUpdate) -> dict[str, Any]:
    user = current_user(request)
    db = await database.get_db()
    try:
        payload = body.model_dump(exclude_none=True)
        # Never accept refresh_token via generic settings PUT
        payload.pop("youtube_refresh_token", None)
        await database.update_user_settings(db, user.email, payload)
        return await database.get_user_settings_public(db, user.email)
    finally:
        await db.close()


@app.get("/channels")
async def channels_list(request: Request, refresh: int = 0) -> list[dict[str, Any]]:
    """List saved channels. refresh=1 re-checks Kick live status for each."""
    user = current_user(request)
    db = await database.get_db()
    try:
        channels = await database.list_channels(db, user.email)
        if not refresh:
            return channels

        async def _refresh_one(ch: dict[str, Any]) -> dict[str, Any]:
            slug = ch.get("slug")
            if not slug:
                return ch
            try:
                fresh = await asyncio.to_thread(fetch_channel, slug)
                return await database.upsert_channel(db, fresh, owner_email=user.email)
            except KickError:
                # Kick unreachable — keep cached row but don't invent live
                return ch

        # Bound concurrency so many channels don't stampede Kick
        sem = asyncio.Semaphore(4)

        async def _guarded(ch: dict[str, Any]) -> dict[str, Any]:
            async with sem:
                return await _refresh_one(ch)

        return list(await asyncio.gather(*[_guarded(ch) for ch in channels]))
    finally:
        await db.close()


@app.post("/channels/refresh-live")
async def channels_refresh_live(request: Request) -> list[dict[str, Any]]:
    """Force-refresh is_live for all saved channels."""
    return await channels_list(request, refresh=1)


@app.post("/channels")
async def channels_create(request: Request, body: ChannelCreate) -> dict[str, Any]:
    user = current_user(request)
    try:
        slug = parse_kick_slug(body.input)
        info = fetch_channel(slug)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except KickError as exc:
        raise HTTPException(400, str(exc)) from exc
    db = await database.get_db()
    try:
        return await database.upsert_channel(db, info, owner_email=user.email)
    finally:
        await db.close()


@app.get("/channels/{slug}")
async def channels_get(request: Request, slug: str) -> dict[str, Any]:
    user = current_user(request)
    db = await database.get_db()
    try:
        channel = await database.get_channel(db, slug, owner_email=user.email)
        if not channel:
            raise HTTPException(404, "Kanal bulunamadı")
        try:
            fresh = fetch_channel(slug)
            channel = await database.upsert_channel(db, fresh, owner_email=user.email)
        except KickError:
            pass
        return channel
    finally:
        await db.close()


@app.delete("/channels/{slug}")
async def channels_delete(request: Request, slug: str) -> dict[str, bool]:
    user = current_user(request)
    db = await database.get_db()
    try:
        ok = await database.delete_channel(db, slug, owner_email=user.email)
        if not ok:
            raise HTTPException(404, "Kanal bulunamadı")
        key = safe_slug(slug)
        await database.delete_channel_assets_for_slug(
            db, owner_email=user.email, slug=key
        )
        folder = settings.assets_dir / safe_owner(user.email) / key
        if folder.exists():
            import shutil

            shutil.rmtree(folder, ignore_errors=True)
        return {"ok": True}
    finally:
        await db.close()


def _asset_public(row: dict[str, Any], slug: str) -> dict[str, Any]:
    asset_id = row["id"]
    return {
        "id": asset_id,
        "name": row.get("name") or "görsel",
        "mime": row.get("mime") or "image/png",
        "created_at": row.get("created_at"),
        "url": f"/channels/{quote(slug)}/assets/{quote(asset_id)}/file",
    }


@app.get("/channels/{slug}/assets")
async def channel_assets_list(request: Request, slug: str) -> list[dict[str, Any]]:
    user = current_user(request)
    key = safe_slug(slug)
    db = await database.get_db()
    try:
        rows = await database.list_channel_assets(db, owner_email=user.email, slug=key)
        return [_asset_public(r, key) for r in rows]
    finally:
        await db.close()


@app.post("/channels/{slug}/assets")
async def channel_assets_create(
    request: Request, slug: str, body: ChannelAssetCreate
) -> dict[str, Any]:
    user = current_user(request)
    key = safe_slug(slug)
    try:
        mime, raw = parse_image_data_url(body.data_url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    db = await database.get_db()
    try:
        n = await database.count_channel_assets(db, owner_email=user.email, slug=key)
        if n >= MAX_ASSETS_PER_CHANNEL:
            raise HTTPException(400, f"Kanal başına en fazla {MAX_ASSETS_PER_CHANNEL} görsel")
        asset_id = uuid.uuid4().hex
        path = asset_path(user.email, key, asset_id)
        path.write_bytes(raw)
        name = (body.name or "görsel").strip()[:80] or "görsel"
        row = await database.add_channel_asset(
            db,
            asset_id=asset_id,
            owner_email=user.email,
            slug=key,
            name=name,
            mime=mime,
        )
        return _asset_public(row, key)
    finally:
        await db.close()


@app.get("/channels/{slug}/assets/{asset_id}/file")
async def channel_assets_file(request: Request, slug: str, asset_id: str) -> FileResponse:
    user = current_user(request)
    key = safe_slug(slug)
    aid = re.sub(r"[^a-fA-F0-9]", "", asset_id)
    if len(aid) < 16:
        raise HTTPException(404, "Görsel bulunamadı")
    db = await database.get_db()
    try:
        row = await database.get_channel_asset(
            db, owner_email=user.email, slug=key, asset_id=aid
        )
        if not row:
            raise HTTPException(404, "Görsel bulunamadı")
        path = asset_path(user.email, key, aid)
        if not path.exists():
            raise HTTPException(404, "Görsel dosyası yok")
        return FileResponse(
            path,
            media_type=row.get("mime") or "image/png",
            headers={"Cache-Control": "private, max-age=3600"},
        )
    finally:
        await db.close()


@app.delete("/channels/{slug}/assets/{asset_id}")
async def channel_assets_delete(request: Request, slug: str, asset_id: str) -> dict[str, bool]:
    user = current_user(request)
    key = safe_slug(slug)
    aid = re.sub(r"[^a-fA-F0-9]", "", asset_id)
    db = await database.get_db()
    try:
        ok = await database.delete_channel_asset(
            db, owner_email=user.email, slug=key, asset_id=aid
        )
        if not ok:
            raise HTTPException(404, "Görsel bulunamadı")
        path = asset_path(user.email, key, aid)
        if path.exists():
            path.unlink()
        return {"ok": True}
    finally:
        await db.close()


@app.get("/channels/{slug}/vods")
async def channels_vods(request: Request, slug: str) -> list[dict[str, Any]]:
    user = current_user(request)
    db = await database.get_db()
    try:
        channel = await database.get_channel(db, slug, owner_email=user.email)
        if not channel:
            raise HTTPException(404, "Kanal bulunamadı")
    finally:
        await db.close()
    try:
        return fetch_vods(slug)
    except KickError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/channels/{slug}/clips")
async def channels_clips(request: Request, slug: str) -> list[dict[str, Any]]:
    user = current_user(request)
    db = await database.get_db()
    try:
        channel = await database.get_channel(db, slug, owner_email=user.email)
        if not channel:
            raise HTTPException(404, "Kanal bulunamadı")
    finally:
        await db.close()
    try:
        return fetch_clips(slug)
    except KickError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/jobs")
async def jobs_list(request: Request, limit: int = 40) -> list[JobOut]:
    user = current_user(request)
    db = await database.get_db()
    try:
        jobs = await database.list_jobs(db, user.email, limit=limit)
        return [job_urls(j) for j in jobs]
    finally:
        await db.close()


@app.delete("/jobs/{job_id}")
async def jobs_delete(request: Request, job_id: str) -> dict[str, bool]:
    user = current_user(request)
    await stop_live_ring(job_id)
    db = await database.get_db()
    try:
        job = await database.get_job_for_owner(db, job_id, user.email)
        if not job:
            raise HTTPException(404, "Job bulunamadı")
        for key in ("local_path", "cut_path"):
            p = job.get(key)
            if p:
                try:
                    Path(p).unlink(missing_ok=True)
                except OSError:
                    pass
        ok = await database.delete_job(db, job_id, owner_email=user.email)
        return {"ok": ok}
    finally:
        await db.close()


@app.post("/jobs/download")
@app.post("/jobs/open")
async def jobs_open(request: Request, body: DownloadRequest) -> JobOut:
    """Open a VOD/clip for editing via remote Kick HLS (no full download)."""
    user = current_user(request)
    kind = body.kind or "vod"
    hls_url = None
    live_playback = None
    duration = float(body.duration or 0)
    title = body.title or "Kick VOD"
    thumbnail = body.thumbnail
    uuid_val = None
    source_url = body.vod_url
    channel_slug = body.channel_slug
    mode = "remote-hls"
    chat_started_at = None
    chat_channel_id = None

    try:
        if kind == "clip":
            clip_id = body.clip_id
            if not clip_id and body.vod_url and "clip=" in body.vod_url:
                clip_id = body.vod_url.split("clip=")[-1].split("&")[0]
            if not clip_id:
                raise HTTPException(400, "clip_id gerekli")
            playback = fetch_clip_playback(clip_id)
            hls_url = playback["hls_url"]
            duration = playback["duration"] or duration
            title = body.title or playback["title"] or title
            thumbnail = thumbnail or playback.get("thumbnail")
            source_url = playback.get("url") or source_url or f"clip:{clip_id}"
            channel_slug = channel_slug or playback.get("channel_slug")
            mode = "clip-hls"
            uuid_val = clip_id
        elif kind == "live":
            if not channel_slug:
                raise HTTPException(400, "channel_slug gerekli")
            playback = fetch_live_playback(channel_slug)
            live_playback = playback
            hls_url = playback.get("dvr_hls_url") or playback["hls_url"]
            title = body.title or playback["title"] or f"{channel_slug} canlı"
            thumbnail = thumbnail or playback.get("thumbnail")
            source_url = playback.get("url") or f"https://kick.com/{channel_slug}"
            mode = "live"
            duration = 0
        else:
            if not body.vod_url:
                raise HTTPException(400, "vod_url gerekli")
            uuid_val = parse_vod_uuid(body.vod_url)
            if uuid_val:
                playback = fetch_vod_playback(uuid_val)
                # Ongoing Kick session listed as VOD — open as true live edge
                if playback.get("is_live") and channel_slug:
                    live_pb = fetch_live_playback(channel_slug)
                    live_playback = live_pb
                    hls_url = live_pb.get("dvr_hls_url") or live_pb["hls_url"]
                    title = body.title or live_pb.get("title") or playback["title"] or title
                    thumbnail = thumbnail or live_pb.get("thumbnail") or playback.get("thumbnail")
                    source_url = live_pb.get("url") or source_url or f"https://kick.com/{channel_slug}"
                    mode = "live"
                    duration = 0
                else:
                    hls_url = playback["hls_url"]
                    duration = playback["duration"] or duration
                    title = body.title or playback["title"] or title
                    thumbnail = thumbnail or playback.get("thumbnail")
                    chat_started_at = playback.get("started_at_unix")
                    chat_channel_id = playback.get("channel_id")
            elif body.vod_url.endswith(".m3u8"):
                hls_url = body.vod_url
    except KickError as exc:
        raise HTTPException(400, str(exc)) from exc

    if not hls_url:
        raise HTTPException(400, "Oynatma kaynağı bulunamadı")

    job_id = uuid.uuid4().hex
    db = await database.get_db()
    try:
        job = await database.create_job(
            db,
            {
                "id": job_id,
                "owner_email": user.email,
                "kind": "live" if mode == "live" else "remote",
                "status": "ready",
                "progress": 100,
                "channel_slug": channel_slug,
                "source_url": source_url,
                "title": title,
                "meta": {
                    "thumbnail": thumbnail,
                    "duration": duration,
                    "hls_url": hls_url,
                    "live_edge_url": (live_playback or {}).get("live_edge_url") or hls_url,
                    "dvr_hls_url": (live_playback or {}).get("dvr_hls_url"),
                    "vod_uuid": uuid_val,
                    "mode": mode,
                    "is_live": mode == "live",
                    "dvr": bool((live_playback or {}).get("dvr")),
                    "chat_started_at": chat_started_at,
                    "chat_channel_id": chat_channel_id,
                    "overlays": [],
                },
            },
        )
    finally:
        await db.close()

    if mode == "live":
        # Prefetch 720p preview + best-quality export URL (Kick session DVR)
        try:
            meta = dict(job.get("meta") or {})
            raw_master, _ = await asyncio.to_thread(fetch_hls_bytes, hls_url, 25.0)
            master_text = raw_master.decode("utf-8", errors="replace")
            if "#EXT-X-STREAM-INF" in master_text:
                preview_url = pick_media_playlist(master_text, hls_url, prefer="720")
                export_url = pick_media_playlist(master_text, hls_url, prefer="best")
            else:
                preview_url = hls_url
                export_url = hls_url
            # Measure DVR length so the editor timeline shows full history immediately
            dvr_sec = 0.0
            try:
                raw_media, _ = await asyncio.to_thread(fetch_hls_bytes, preview_url, 45.0)
                dvr_sec = playlist_duration_seconds(
                    raw_media.decode("utf-8", errors="replace")
                )
            except Exception:
                dvr_sec = 0.0
            meta.update(
                {
                    "preview_hls_url": preview_url,
                    "export_hls_url": export_url,
                    "hls_resolved_at": time.time(),
                    "hls_url": hls_url,
                    "dvr_hls_url": (live_playback or {}).get("dvr_hls_url") or hls_url,
                    "duration": dvr_sec,
                    "dvr_seconds": dvr_sec,
                }
            )
            db2 = await database.get_db()
            try:
                updated = await database.update_job(db2, job_id, meta=meta)
                if updated:
                    job = updated
            finally:
                await db2.close()
        except Exception:
            pass
        if source_url:
            await start_live_ring(job_id, source_url)

    return job_urls(job)


@app.post("/jobs/open-live")
async def jobs_open_live(request: Request, body: LiveOpenRequest) -> JobOut:
    return await jobs_open(
        request,
        DownloadRequest(
            kind="live",
            channel_slug=body.channel_slug,
            title=body.title,
            vod_url="",
        ),
    )


@app.get("/jobs/{job_id}")
async def jobs_get(request: Request, job_id: str) -> JobOut:
    db = await database.get_db()
    try:
        job = await owned_job(db, request, job_id)
        # Only mark failed if the in-memory task finished without updating status.
        # Do NOT fail when task is missing (tab closed / poll from another page —
        # background create_task may still be running, or worker was restarted).
        if job.get("status") in _ACTIVE_YT:
            task = _youtube_tasks.get(job_id)
            if task is not None and task.done() and not task.cancelled():
                still = job.get("status") in _ACTIVE_YT
                if still:
                    err = "Yükleme kesildi veya takıldı. Tekrar YouTube'a yükle butonuna basın."
                    try:
                        exc = task.exception()
                        if exc:
                            err = str(exc)[:240]
                    except Exception:  # noqa: BLE001
                        pass
                    job = (
                        await database.update_job(
                            db,
                            job_id,
                            status="error",
                            error=err,
                        )
                        or job
                    )
        return job_urls(job)
    finally:
        await db.close()


@app.get("/jobs/{job_id}/chat")
async def jobs_chat(request: Request, job_id: str, t: float = 0) -> dict[str, Any]:
    """Kick chat around playback second t (VOD wall-clock or live DVR rewind)."""
    db = await database.get_db()
    try:
        job = await owned_job(db, request, job_id)
        meta = dict(job.get("meta") or {})
        slug = job.get("channel_slug")
        if not slug:
            raise HTTPException(400, "Bu işte kanal yok")
        mode = meta.get("mode")
        is_live = mode == "live" or job.get("kind") == "live"
        duration = max(0.0, float(meta.get("duration") or meta.get("dvr_seconds") or 0))
        play_t = max(0.0, float(t or 0))

        channel_id = meta.get("chat_channel_id")
        started_at = meta.get("chat_started_at")
        if not channel_id or (not is_live and not started_at):
            ctx = await asyncio.to_thread(
                resolve_chat_context, slug, meta.get("vod_uuid")
            )
            channel_id = ctx.get("channel_id") or channel_id
            if ctx.get("started_at"):
                started_at = ctx["started_at"]
            meta["chat_channel_id"] = channel_id
            meta["chatroom_id"] = ctx.get("chatroom_id")
            if started_at:
                meta["chat_started_at"] = started_at
            await database.update_job(db, job_id, meta=meta)

        if not channel_id:
            raise HTTPException(400, "Kick sohbet odası bulunamadı")

        now = time.time()
        behind = False
        if is_live:
            lag = max(0.0, duration - play_t) if duration > 1 else 0.0
            behind = lag > 4.0
            wall = now - lag if behind else now
        else:
            start = float(started_at or 0)
            if start <= 0:
                raise HTTPException(400, "VOD başlangıç zamanı yok")
            wall = start + play_t

        live_edge = bool(is_live and not behind)
        try:
            msgs, degraded = await asyncio.to_thread(
                fetch_chat_around,
                channel_id,
                wall,
                live_edge=live_edge,
            )
        except KickError as exc:
            detail = str(exc)
            status = 429 if "limit" in detail.lower() or "403" in detail or "429" in detail else 400
            raise HTTPException(status, detail) from exc

        out: list[dict[str, Any]] = []
        for msg in msgs:
            offset = play_t - (wall - float(msg["ts"]))
            out.append({**msg, "offset_sec": round(max(0.0, offset), 2)})
        if out:
            offsets = [float(m["offset_sec"]) for m in out]
            cover_from = round(max(0.0, min(offsets)), 2)
            cover_to = round(max(offsets), 2)
        else:
            cover_from = round(play_t, 2)
            cover_to = round(play_t + 3.0, 2)
        return {
            "live": bool(is_live),
            "behind": behind,
            "t": play_t,
            "wall_ts": wall,
            "cover_from": cover_from,
            "cover_to": cover_to,
            "degraded": degraded,
            "messages": out[-120:],
        }
    finally:
        await db.close()


@app.get("/jobs/{job_id}/stream.m3u8")
async def jobs_stream_master(request: Request, job_id: str) -> Response:
    """Serve a preview playlist (VOD seekable, or live sliding window)."""
    db = await database.get_db()
    try:
        job = await owned_job(db, request, job_id)
        meta = job.get("meta") or {}
        hls_url = meta.get("dvr_hls_url") or meta.get("hls_url") or meta.get("live_edge_url")
        if not hls_url:
            raise HTTPException(400, "Bu job için HLS yok")

        is_live = (
            meta.get("mode") == "live"
            or job.get("kind") == "live"
            or bool(meta.get("is_live"))
        )

        # Live: refresh Kick URL occasionally (not every playlist poll)
        now = time.time()
        resolved_at = float(meta.get("hls_resolved_at") or 0)
        if is_live and job.get("channel_slug") and (now - resolved_at > 600 or not hls_url):
            try:
                live_pb = await asyncio.to_thread(
                    fetch_live_playback, job["channel_slug"]
                )
                new_url = live_pb.get("dvr_hls_url") or live_pb.get("hls_url") or live_pb.get("live_edge_url")
                if new_url:
                    changed = new_url != hls_url
                    hls_url = new_url
                    meta = {
                        **meta,
                        "hls_url": hls_url,
                        "live_edge_url": live_pb.get("live_edge_url") or hls_url,
                        "dvr_hls_url": live_pb.get("dvr_hls_url"),
                        "hls_resolved_at": now,
                        "mode": "live",
                        "is_live": True,
                        "dvr": bool(live_pb.get("dvr")),
                    }
                    if changed:
                        meta["preview_hls_url"] = None
                    await database.update_job(db, job_id, meta=meta)
            except KickError:
                pass

        preview_url = meta.get("preview_hls_url")
        try:
            if not preview_url:
                raw_master, _ = await asyncio.to_thread(fetch_hls_bytes, hls_url, 25.0 if is_live else 20.0)
                master_text = raw_master.decode("utf-8", errors="replace")
                if "#EXT-X-STREAM-INF" in master_text:
                    dur = float(meta.get("duration") or 0)
                    prefer = "720" if (is_live or dur < 3 * 3600) else "480"
                    preview_url = pick_media_playlist(master_text, hls_url, prefer=prefer)
                    if is_live:
                        meta["export_hls_url"] = pick_media_playlist(
                            master_text, hls_url, prefer="best"
                        )
                else:
                    preview_url = hls_url
                meta = {**meta, "preview_hls_url": preview_url}
                await database.update_job(db, job_id, meta=meta)

            # Live DVR playlists can be large (hours of EXTINF) — allow more time
            raw, _ = await asyncio.to_thread(
                fetch_hls_bytes, preview_url, 45.0 if is_live else 20.0
            )
        except KickError as exc:
            raise HTTPException(502, str(exc)) from exc

        text = raw.decode("utf-8", errors="replace")
        if is_live:
            dvr_sec = playlist_duration_seconds(text)
            prev = float(meta.get("duration") or meta.get("dvr_seconds") or 0)
            if dvr_sec > prev + 0.5:
                meta = {**meta, "duration": dvr_sec, "dvr_seconds": dvr_sec}
                await database.update_job(db, job_id, meta=meta)
        rewritten = _rewrite_playlist(
            text, preview_url, as_vod=not is_live, live=is_live
        )
        headers = {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
        }
        if is_live:
            dvr_sec = float(meta.get("dvr_seconds") or meta.get("duration") or 0)
            if dvr_sec > 0:
                headers["X-DVR-Seconds"] = f"{dvr_sec:.3f}"
        return Response(
            content=rewritten,
            media_type="application/vnd.apple.mpegurl",
            headers=headers,
        )
    finally:
        await db.close()


# Shared HTTP client for HLS segment proxy
_hls_client: httpx.AsyncClient | None = None
# Cap concurrent Kick fetches without fail-fast 503 (queue instead).
_hls_sem = asyncio.Semaphore(20)


def get_hls_client() -> httpx.AsyncClient:
    global _hls_client
    if _hls_client is None or _hls_client.is_closed:
        _hls_client = httpx.AsyncClient(
            timeout=httpx.Timeout(45.0, connect=10.0),
            follow_redirects=True,
            limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
            http2=False,
        )
    return _hls_client


@app.get("/hls/seg")
async def hls_segment(u: str, live: int = 0) -> Response:
    """Proxy Kick HLS assets. Buffer body so semaphore never leaks on cancel."""
    is_live = bool(live)
    try:
        target = _unb64url(u)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, "Geçersiz segment") from exc
    parsed = urlparse(target)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(400, "Geçersiz URL")

    headers = {
        "Referer": "https://kick.com/",
        "Origin": "https://kick.com",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        ),
        "Accept": "*/*",
    }

    await _hls_sem.acquire()
    try:
        if target.endswith(".m3u8"):
            try:
                raw, _content_type = await asyncio.to_thread(fetch_hls_bytes, target)
            except KickError as exc:
                raise HTTPException(502, str(exc)) from exc
            text = raw.decode("utf-8", errors="replace")
            body = _rewrite_playlist(
                text, target, as_vod=not is_live, live=is_live
            ).encode("utf-8")
            return Response(
                content=body,
                media_type="application/vnd.apple.mpegurl",
                headers={"Cache-Control": "no-cache"},
            )

        media_type = "video/MP2T"
        if target.endswith(".aac"):
            media_type = "audio/aac"
        elif target.endswith(".m4s"):
            media_type = "video/iso.segment"
        elif target.endswith(".mp4"):
            media_type = "video/mp4"

        client = get_hls_client()
        try:
            resp = await client.get(target, headers=headers)
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"Segment alınamadı: {exc}") from exc
        if resp.status_code >= 400:
            raise HTTPException(resp.status_code, "Upstream segment hatası")

        return Response(
            content=resp.content,
            media_type=media_type,
            headers={
                "Cache-Control": "public, max-age=3600" if not is_live else "no-cache",
                "Accept-Ranges": "bytes",
            },
        )
    finally:
        _hls_sem.release()


def _sync_job_progress(job_id: str, progress: float, status: str = "cutting") -> None:
    """Best-effort progress from worker threads (aiosqlite not usable there)."""
    import sqlite3

    try:
        conn = sqlite3.connect(str(settings.db_path), timeout=5)
        try:
            conn.execute(
                "UPDATE jobs SET progress = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
                (round(progress, 1), status, job_id),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        pass


async def _ensure_segment_file(
    db: Any,
    job: dict[str, Any],
    start_sec: float,
    end_sec: float,
    overlays: list[dict[str, Any]] | None = None,
    *,
    finalize: bool = True,
    hold_heavy: bool = True,
    for_youtube: bool = False,
) -> dict[str, Any]:
    job_id = job["id"]
    meta = job.get("meta") or {}
    dest = settings.media_dir / f"{job_id}_cut.mp4"
    ov = overlays if overlays is not None else list(meta.get("overlays") or [])
    synced = "+sync" in str(meta.get("export_tool") or "")
    # Reuse existing cut if same range + overlays
    if (
        job.get("cut_path")
        and Path(job["cut_path"]).exists()
        and abs(float(meta.get("start_sec", -1)) - start_sec) < 0.05
        and abs(float(meta.get("end_sec", -1)) - end_sec) < 0.05
        and meta.get("overlays_applied") == ov
        and (not for_youtube or synced)
    ):
        return job

    if hold_heavy:
        async with _heavy_job_sem:
            return await _ensure_segment_file(
                db,
                job,
                start_sec,
                end_sec,
                overlays,
                finalize=finalize,
                hold_heavy=False,
                for_youtube=for_youtube,
            )

    clip_len = max(0.1, end_sec - start_sec)
    expected_out = overlay_output_duration(clip_len, ov) if ov else clip_len
    await database.update_job(db, job_id, status="cutting", progress=12, error=None)
    page_url = job.get("source_url") or ""
    hls_url = meta.get("export_hls_url") or meta.get("dvr_hls_url") or meta.get("hls_url")
    local = job.get("local_path")
    mode = meta.get("mode")

    # Live: prefer session/DVR HLS cut; ring file is fallback
    if mode == "live":
        window = ring_window_path(job_id)
        if hls_url:
            local = None
        elif window.exists():
            local = str(window)
            try:
                ring_dur = probe_duration(window)
                meta["duration"] = ring_dur
            except FFmpegError:
                pass

    def _work() -> tuple[Path, str]:
        raw_dest = settings.media_dir / f"{job_id}_cut_raw.mp4"
        _sync_job_progress(job_id, 18, "cutting")

        def _dl_prog(frac: float) -> None:
            _sync_job_progress(job_id, 18 + max(0.0, min(1.0, frac)) * 30, "cutting")

        if local and Path(local).exists():
            _sync_job_progress(job_id, 28, "cutting")
            path = cut_media(Path(local), raw_dest if ov else dest, start_sec, end_sec)
            tool = "local-cut"
        else:
            path, tool = download_segment(
                page_url=page_url,
                hls_url=hls_url,
                output=raw_dest if ov else dest,
                start_sec=start_sec,
                end_sec=end_sec,
                quality="best",
                on_progress=_dl_prog,
            )
            # HLS remux can leave broken timestamps → YouTube shows wrong length + glitches
            path = ensure_clip_duration(path, clip_len, label="kesit")
        if ov:
            def _ov_prog(frac: float) -> None:
                _sync_job_progress(job_id, 48 + max(0.0, min(1.0, frac)) * 18, "exporting")

            _sync_job_progress(job_id, 48, "exporting")
            path = apply_overlays(
                path, dest, ov, clip_duration=clip_len, on_progress=_ov_prog
            )
            tool = f"{tool}+effects"
            if raw_dest.exists() and raw_dest.resolve() != dest.resolve():
                try:
                    raw_dest.unlink()
                except OSError:
                    pass
        elif for_youtube:
            _sync_job_progress(job_id, 66, "exporting")
        else:
            _sync_job_progress(job_id, 74, "cutting")

        if for_youtube:
            def _prep_prog(frac: float) -> None:
                _sync_job_progress(job_id, 66 + max(0.0, min(1.0, frac)) * 20, "exporting")

            _sync_job_progress(job_id, 66, "exporting")
            path = prepare_for_youtube(
                path,
                expected_out,
                source_tool=tool,
                on_progress=_prep_prog,
            )
            tool = f"{tool}+sync"
        return path, tool

    try:
        path, tool = await asyncio.to_thread(_work)
    except (DownloadError, FFmpegError) as exc:
        await database.update_job(db, job_id, status="error", error=str(exc))
        raise HTTPException(400, str(exc)) from exc

    # Local download: fix Kick HLS VFR so A/V stay in sync
    if finalize and not for_youtube:
        try:
            def _prep_prog(frac: float) -> None:
                _sync_job_progress(job_id, 74 + max(0.0, min(1.0, frac)) * 20, "exporting")

            _sync_job_progress(job_id, 74, "exporting")
            path = await asyncio.to_thread(
                prepare_for_youtube,
                Path(path),
                expected_out,
                source_tool=tool,
                on_progress=_prep_prog,
            )
            tool = f"{tool}+sync"
            _sync_job_progress(job_id, 94, "exporting")
        except FFmpegError as exc:
            await database.update_job(db, job_id, status="error", error=str(exc))
            raise HTTPException(400, str(exc)) from exc

    meta.update(
        {
            "start_sec": start_sec,
            "end_sec": end_sec,
            "export_tool": tool,
            "overlays": ov,
            "overlays_applied": ov,
        }
    )
    end_progress = 100 if finalize else (86 if for_youtube else 74)
    updated = await database.update_job(
        db,
        job_id,
        status="cut" if finalize else "exporting",
        progress=end_progress,
        cut_path=str(path),
        meta=meta,
    )
    return updated or job


@app.post("/jobs/{job_id}/cut")
async def jobs_cut(request: Request, job_id: str, body: CutRequest) -> JobOut:
    db = await database.get_db()
    try:
        job = await owned_job(db, request, job_id)
        updated = await _ensure_segment_file(db, job, body.start_sec, body.end_sec)
        return job_urls(updated)
    finally:
        await db.close()


@app.get("/auth/youtube/start")
async def youtube_start(request: Request) -> dict[str, str]:
    user = current_user(request)
    db = await database.get_db()
    try:
        us = await database.get_user_settings(db, user.email)
        client_id = (us.get("youtube_client_id") or "").strip()
        client_secret = (us.get("youtube_client_secret") or "").strip()
        if not client_id or not client_secret:
            raise HTTPException(400, "YouTube Client ID/Secret ayarlarda gerekli")
        redirect_uri = f"{settings.web_origin.rstrip('/')}/api/auth/youtube/callback"
        state = new_oauth_state()
        await database.update_user_settings(
            db, user.email, {"youtube_oauth_state": state}
        )
        auth_url = build_auth_url(
            client_id=client_id,
            redirect_uri=redirect_uri,
            state=state,
        )
        return {"auth_url": auth_url, "redirect_uri": redirect_uri}
    finally:
        await db.close()


@app.get("/auth/youtube/callback")
async def youtube_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    origin = settings.web_origin.rstrip("/")
    if error:
        return RedirectResponse(f"{origin}/?youtube=error&reason={quote(error)}")
    if not code:
        return RedirectResponse(f"{origin}/?youtube=error&reason=missing_code")

    try:
        user = current_user(request)
    except HTTPException:
        return RedirectResponse(f"{origin}/?youtube=error&reason=login_required")

    db = await database.get_db()
    try:
        us = await database.get_user_settings(db, user.email)
        saved_state = (us.get("youtube_oauth_state") or "").strip()
        if not saved_state or not state or saved_state != state:
            return RedirectResponse(f"{origin}/?youtube=error&reason=state_mismatch")

        client_id = (us.get("youtube_client_id") or "").strip()
        client_secret = (us.get("youtube_client_secret") or "").strip()
        if not client_id or not client_secret:
            return RedirectResponse(f"{origin}/?youtube=error&reason=missing_credentials")

        redirect_uri = f"{origin}/api/auth/youtube/callback"
        try:
            tokens = await asyncio.to_thread(
                exchange_code_for_tokens,
                client_id=client_id,
                client_secret=client_secret,
                redirect_uri=redirect_uri,
                code=code,
            )
        except YoutubeError as exc:
            return RedirectResponse(
                f"{origin}/?youtube=error&reason={quote(str(exc)[:200])}"
            )
        except Exception as exc:  # noqa: BLE001
            return RedirectResponse(
                f"{origin}/?youtube=error&reason={quote(str(exc)[:200])}"
            )

        await database.update_user_settings(
            db,
            user.email,
            {
                "youtube_refresh_token": tokens["refresh_token"],
                "youtube_oauth_state": "",
            },
        )
        return RedirectResponse(f"{origin}/?youtube=connected")
    finally:
        await db.close()


# Prevent stacking multiple YouTube exports for the same job
_youtube_tasks: dict[str, asyncio.Task[None]] = {}


def _cleanup_export_media(job_id: str, job: dict[str, Any] | None = None) -> None:
    """Delete cut/thumb export files after a successful YouTube publish."""
    paths: list[Path] = []
    if job:
        for key in ("cut_path",):
            raw = job.get(key)
            if raw:
                paths.append(Path(str(raw)))
    media = settings.media_dir
    for pattern in (
        f"{job_id}_cut.mp4",
        f"{job_id}_cut_raw.mp4",
        f"{job_id}_cut_yt.mp4",
        f"{job_id}_cut_fix.mp4",
        f"{job_id}_thumb.jpg",
        f"{job_id}_thumb.jpeg",
        f"{job_id}_thumb.png",
    ):
        paths.append(media / pattern)
    # Catch leftover prepare/fix intermediates
    try:
        for p in media.glob(f"{job_id}_cut*"):
            if p.is_file():
                paths.append(p)
        for p in media.glob(f"{job_id}_thumb*"):
            if p.is_file():
                paths.append(p)
    except OSError:
        pass
    seen: set[str] = set()
    for path in paths:
        key = str(path.resolve()) if path.exists() else str(path)
        if key in seen:
            continue
        seen.add(key)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def _sync_upload_progress(job_id: str, frac: float) -> None:
    """Best-effort progress from the upload thread (aiosqlite not usable there)."""
    progress = round(88 + max(0.0, min(1.0, frac)) * 10, 1)
    _sync_job_progress(job_id, progress, "uploading")


def _sync_processing_progress(job_id: str, tick: dict[str, Any]) -> None:
    pct = tick.get("processingProgress")
    if pct is not None:
        progress = round(90 + max(0.0, min(100.0, float(pct))) * 0.09, 1)
    else:
        progress = 92.0
    _sync_job_progress(job_id, progress, "processing")


async def _run_youtube_pipeline(
    job_id: str,
    *,
    owner_email: str,
    title: str,
    description: str,
    privacy: str,
    start_sec: float,
    end_sec: float,
    overlays: list[dict[str, Any]] | None = None,
    thumbnail_data_url: str | None = None,
) -> None:
    db = await database.get_db()
    try:
        job = await database.get_job(db, job_id)
        if not job:
            return

        async with _heavy_job_sem:
            await database.update_job(db, job_id, status="exporting", progress=10, error=None)
            try:
                job = await _ensure_segment_file(
                    db,
                    job,
                    start_sec,
                    end_sec,
                    overlays=overlays,
                    finalize=False,
                    hold_heavy=False,
                    for_youtube=True,
                )
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
                await database.update_job(db, job_id, status="error", error=detail)
                return

            upload_path = job.get("cut_path")
            if not upload_path or not Path(upload_path).exists():
                await database.update_job(
                    db, job_id, status="error", error="Yüklenecek kesit dosyası yok"
                )
                return

            us = await database.get_user_settings(db, owner_email)
            client_id = (us.get("youtube_client_id") or "").strip()
            client_secret = (us.get("youtube_client_secret") or "").strip()
            refresh = (us.get("youtube_refresh_token") or "").strip()
            if not client_id or not client_secret or not refresh:
                await database.update_job(
                    db,
                    job_id,
                    status="error",
                    error="YouTube OAuth tamamlanmamış — Ayarlar'dan bağlayın",
                )
                return

            path = Path(upload_path)
            await database.update_job(db, job_id, status="uploading", progress=88, error=None)
            size = path.stat().st_size
            # Assume ~512 KiB/s worst case + 20 min slack (multi‑GB uploads)
            upload_timeout = max(1800.0, size / (512 * 1024) + 1200)
            upload_timeout = min(upload_timeout, 12 * 3600)

            def _upload() -> dict[str, Any]:
                return upload_video(
                    client_id=client_id,
                    client_secret=client_secret,
                    refresh_token=refresh,
                    file_path=path,
                    title=title,
                    description=description,
                    privacy=privacy,
                    on_progress=lambda frac: _sync_upload_progress(job_id, frac),
                )

            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(_upload), timeout=upload_timeout
                )
            except TimeoutError:
                await database.update_job(
                    db,
                    job_id,
                    status="error",
                    error="YouTube yükleme zaman aşımı — tekrar deneyin",
                )
                return
            except YoutubeError as exc:
                await database.update_job(db, job_id, status="error", error=str(exc))
                return
            except Exception as exc:  # noqa: BLE001
                await database.update_job(
                    db, job_id, status="error", error=f"YouTube yükleme hatası: {exc}"
                )
                return

            video_id = result.get("id")
            if not video_id:
                await database.update_job(
                    db, job_id, status="error", error="YouTube video id dönmedi"
                )
                return

            meta = job.get("meta") or {}
            meta["youtube"] = {
                "id": video_id,
                "url": result.get("url") or f"https://www.youtube.com/watch?v={video_id}",
                "uploadStatus": result.get("uploadStatus") or "uploaded",
                "processingStatus": result.get("processingStatus") or "processing",
            }
            await database.update_job(
                db,
                job_id,
                status="processing",
                progress=90,
                title=title,
                meta=meta,
                error=None,
            )

            if thumbnail_data_url and thumbnail_data_url.startswith("data:image"):
                try:
                    await asyncio.sleep(1.0)
                    _header, b64 = thumbnail_data_url.split(",", 1)
                    raw = base64.b64decode(b64)
                    thumb_path = settings.media_dir / f"{job_id}_thumb.jpg"
                    thumb_path.write_bytes(raw)
                    await asyncio.to_thread(
                        set_thumbnail,
                        client_id=client_id,
                        client_secret=client_secret,
                        refresh_token=refresh,
                        video_id=video_id,
                        image_path=thumb_path,
                    )
                except Exception as exc:  # noqa: BLE001
                    meta["thumb_error"] = str(exc)[:200]
                    await database.update_job(db, job_id, meta=meta)

        # Release heavy slot before long YouTube processing poll
        def _on_proc(tick: dict[str, Any]) -> None:
            _sync_processing_progress(job_id, tick)
            try:
                import json as _json
                import sqlite3

                conn = sqlite3.connect(str(settings.db_path), timeout=5)
                try:
                    row = conn.execute(
                        "SELECT meta_json FROM jobs WHERE id = ?", (job_id,)
                    ).fetchone()
                    cur = {}
                    if row and row[0]:
                        cur = _json.loads(row[0])
                    yt = dict(cur.get("youtube") or {})
                    yt.update(
                        {
                            "uploadStatus": tick.get("uploadStatus") or "",
                            "processingStatus": tick.get("processingStatus") or "",
                            "processingProgress": tick.get("processingProgress"),
                        }
                    )
                    cur["youtube"] = yt
                    conn.execute(
                        "UPDATE jobs SET meta_json = ?, updated_at = datetime('now') WHERE id = ?",
                        (_json.dumps(cur), job_id),
                    )
                    conn.commit()
                finally:
                    conn.close()
            except Exception:  # noqa: BLE001
                pass

        try:
            final = await asyncio.to_thread(
                wait_until_processed,
                client_id=client_id,
                client_secret=client_secret,
                refresh_token=refresh,
                video_id=str(video_id),
                on_tick=_on_proc,
                poll_sec=4.0,
                timeout_sec=2 * 3600,
            )
        except YoutubeError as exc:
            await database.update_job(db, job_id, status="error", error=str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            await database.update_job(
                db, job_id, status="error", error=f"YouTube işleme hatası: {exc}"
            )
            return

        meta = job.get("meta") or {}
        meta["youtube"] = {
            "id": video_id,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "uploadStatus": final.get("uploadStatus") or "processed",
            "processingStatus": final.get("processingStatus") or "succeeded",
            "processingProgress": final.get("processingProgress"),
        }
        # Drop applied markers so a future re-export rebuilds from source HLS
        meta.pop("overlays_applied", None)
        await database.update_job(
            db,
            job_id,
            status="done",
            progress=100,
            title=title,
            meta=meta,
            error=None,
            cut_path=None,
        )
        # Free disk once YouTube processing succeeded
        await asyncio.to_thread(_cleanup_export_media, job_id, job)
    finally:
        await db.close()
        _youtube_tasks.pop(job_id, None)


@app.put("/jobs/{job_id}/timeline")
async def jobs_timeline(request: Request, job_id: str, body: TimelineUpdate) -> JobOut:
    db = await database.get_db()
    try:
        job = await owned_job(db, request, job_id)
        meta = job.get("meta") or {}
        meta["overlays"] = [o.model_dump() for o in body.overlays]
        # Force re-export next time
        meta.pop("overlays_applied", None)
        updated = await database.update_job(db, job_id, meta=meta)
        return job_urls(updated or job)
    finally:
        await db.close()


@app.get("/jobs/{job_id}/ring")
async def jobs_ring(request: Request, job_id: str) -> dict[str, Any]:
    db = await database.get_db()
    try:
        job = await owned_job(db, request, job_id)
        status = ring_status(job_id)
        if status.get("window_path"):
            await database.update_job(
                db,
                job_id,
                local_path=status["window_path"],
                meta={
                    **(job.get("meta") or {}),
                    "duration": status.get("duration") or 0,
                    "ring": status,
                },
            )
        return status
    finally:
        await db.close()


@app.post("/jobs/{job_id}/youtube")
async def jobs_youtube(request: Request, job_id: str, body: YoutubeUploadRequest) -> JobOut:
    """Start export+upload in background; client should poll GET /jobs/{id}."""
    user = current_user(request)
    db = await database.get_db()
    try:
        job = await owned_job(db, request, job_id)

        existing = _youtube_tasks.get(job_id)
        if existing and not existing.done():
            existing.cancel()
            try:
                await existing
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            _youtube_tasks.pop(job_id, None)

        start = float(
            body.start_sec
            if body.start_sec is not None
            else (job.get("meta") or {}).get("start_sec")
            or 0
        )
        end = body.end_sec
        if end is None:
            end = (job.get("meta") or {}).get("end_sec")
        if end is None:
            raise HTTPException(400, "Kesit aralığı (start/end) gerekli — tam VOD indirme kapalı")
        end = float(end)
        if end - start <= 0:
            raise HTTPException(400, "Geçersiz kesit aralığı")
        if end - start > 8 * 60 * 60:
            raise HTTPException(400, "Kesit en fazla 8 saat olabilir (disk/süre koruması)")

        us = await database.get_user_settings(db, user.email)
        client_id = (us.get("youtube_client_id") or "").strip()
        client_secret = (us.get("youtube_client_secret") or "").strip()
        refresh = (us.get("youtube_refresh_token") or "").strip()
        if not client_id or not client_secret or not refresh:
            raise HTTPException(400, "YouTube OAuth tamamlanmamış — Ayarlar'dan bağlayın")

        overlays = (
            [o.model_dump() for o in body.overlays]
            if body.overlays is not None
            else list((job.get("meta") or {}).get("overlays") or [])
        )

        updated = await database.update_job(
            db, job_id, status="queued", progress=5, error=None, title=body.title
        )
        task = asyncio.create_task(
            _run_youtube_pipeline(
                job_id,
                owner_email=user.email,
                title=body.title,
                description=body.description,
                privacy=body.privacy,
                start_sec=start,
                end_sec=end,
                overlays=overlays,
                thumbnail_data_url=body.thumbnail_data_url,
            )
        )
        _youtube_tasks[job_id] = task
        return job_urls(updated or job)
    finally:
        await db.close()


def _safe_download_name(title: str | None, job_id: str, kind: str) -> str:
    raw = (title or "").strip() or f"cutmuck-{job_id[:8]}"
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "", raw).strip(" .")[:80]
    if not cleaned:
        cleaned = f"cutmuck-{job_id[:8]}"
    suffix = "cut" if kind == "cut" else "source"
    return f"{cleaned}_{suffix}.mp4"


@app.get("/file/{job_id}")
async def file_for_job(request: Request, job_id: str, kind: str = "source") -> FileResponse:
    db = await database.get_db()
    try:
        job = await owned_job(db, request, job_id)
        path_str = job.get("cut_path") if kind == "cut" else job.get("local_path") or job.get("cut_path")
        if not path_str:
            raise HTTPException(404, "Dosya yok")
        path = Path(path_str)
        if not path.exists():
            raise HTTPException(404, "Dosya diskte yok")
        return FileResponse(
            path,
            media_type="video/mp4",
            filename=_safe_download_name(job.get("title"), job_id, kind),
            content_disposition_type="attachment",
        )
    finally:
        await db.close()
