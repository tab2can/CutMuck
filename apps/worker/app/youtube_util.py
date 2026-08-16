from __future__ import annotations

import secrets
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

# Upload + thumbnail. Single scope avoids invalid_scope on consent/refresh.
SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]
AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
UPLOAD_INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
THUMB_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set"

# YouTube requires chunk sizes that are multiples of 256 KiB (except the last).
_CHUNK_UNIT = 256 * 1024


def _chunk_size_for(file_size: int) -> int:
    """Larger chunks for big uploads → fewer round-trips (30–40GB friendly)."""
    if file_size >= 8 * 1024**3:  # >= 8 GiB
        return 32 * _CHUNK_UNIT  # 8 MiB
    if file_size >= 1024**3:  # >= 1 GiB
        return 16 * _CHUNK_UNIT  # 4 MiB
    if file_size >= 200 * 1024**2:  # >= 200 MiB
        return 8 * _CHUNK_UNIT  # 2 MiB
    return 4 * _CHUNK_UNIT  # 1 MiB


class YoutubeError(Exception):
    pass


def _is_transient(exc: BaseException, status: int | None = None) -> bool:
    if status in {500, 502, 503, 504, 429}:
        return True
    text = str(exc).lower()
    return any(
        token in text
        for token in (
            "invalid_session_id",
            "ssl",
            "connection reset",
            "timed out",
            "timeout",
            "temporarily",
            "connection aborted",
            "eof occurred",
        )
    )


def build_auth_url(*, client_id: str, redirect_uri: str, state: str) -> str:
    """Classic web OAuth URL without PKCE (client_secret flow)."""
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        # Avoid incremental-scope quirks that can yield invalid_scope on refresh
        "include_granted_scopes": "false",
        "state": state,
    }
    return f"{AUTH_URI}?{urlencode(params)}"


def new_oauth_state() -> str:
    return secrets.token_urlsafe(24)


def exchange_code_for_tokens(
    *,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    code: str,
) -> dict[str, Any]:
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            TOKEN_URI,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
        )
    data = resp.json()
    if resp.status_code >= 400:
        detail = data.get("error_description") or data.get("error") or resp.text
        raise YoutubeError(f"Token alınamadı: {detail}")
    if not data.get("refresh_token"):
        raise YoutubeError(
            "Refresh token gelmedi. Google hesabında uygulamayı kaldırıp tekrar deneyin "
            "(prompt=consent)."
        )
    return data


def refresh_access_token(
    client_id: str,
    client_secret: str,
    refresh_token: str,
) -> str:
    """Refresh via httpx (avoids Windows httplib/requests SSL INVALID_SESSION_ID)."""
    last_error: BaseException | None = None
    for attempt in range(1, 5):
        try:
            with httpx.Client(timeout=30.0, http2=False) as client:
                resp = client.post(
                    TOKEN_URI,
                    data={
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "refresh_token": refresh_token,
                        "grant_type": "refresh_token",
                    },
                    headers={"Accept": "application/json"},
                )
            data = resp.json() if resp.content else {}
            if resp.status_code >= 400:
                err = data.get("error") or ""
                detail = data.get("error_description") or err or resp.text
                if err in {"invalid_scope", "invalid_grant"}:
                    raise YoutubeError(
                        "YouTube oturumu geçersiz. "
                        "Ayarlar → YouTube’u yeniden bağla ile tekrar yetkilendirin."
                    )
                raise YoutubeError(f"Token yenilenemedi: {detail}")
            token = data.get("access_token")
            if not token:
                raise YoutubeError("Access token alınamadı")
            return str(token)
        except YoutubeError:
            raise
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < 4 and _is_transient(exc):
                time.sleep(0.6 * attempt)
                continue
            raise YoutubeError(f"YouTube token yenilenemedi: {exc}") from exc
    raise YoutubeError(f"YouTube token yenilenemedi: {last_error}")


def credentials_from_refresh(
    client_id: str,
    client_secret: str,
    refresh_token: str,
) -> Any:
    """Compatibility helper — returns a simple object with .token set."""

    class _Tok:
        def __init__(self, token: str) -> None:
            self.token = token
            self.refresh_token = refresh_token

    return _Tok(refresh_access_token(client_id, client_secret, refresh_token))


def upload_video(
    *,
    client_id: str,
    client_secret: str,
    refresh_token: str,
    file_path: Path,
    title: str,
    description: str,
    privacy: str = "unlisted",
    on_progress: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """Resumable upload via httpx (avoids httplib2 SSL hangs on Windows)."""
    if not file_path.exists():
        raise YoutubeError("Yüklenecek dosya yok")

    file_size = file_path.stat().st_size
    if file_size <= 0:
        raise YoutubeError("Kesit dosyası boş")

    chunk_size = _chunk_size_for(file_size)
    # Large chunks need longer write/read windows
    io_timeout = 180.0 if chunk_size >= 4 * _CHUNK_UNIT else 120.0
    timeout = httpx.Timeout(io_timeout, connect=30.0, read=io_timeout, write=io_timeout)

    body = {
        "snippet": {
            "title": title[:100],
            "description": description[:5000],
            "categoryId": "22",
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
        },
    }
    last_error: BaseException | None = None

    for attempt in range(1, 6):
        try:
            creds = credentials_from_refresh(client_id, client_secret, refresh_token)
            if not creds.token:
                raise YoutubeError("Access token alınamadı")

            with httpx.Client(timeout=timeout, follow_redirects=False) as client:
                init = client.post(
                    UPLOAD_INIT_URL,
                    params={"uploadType": "resumable", "part": "snippet,status"},
                    headers={
                        "Authorization": f"Bearer {creds.token}",
                        "Content-Type": "application/json; charset=UTF-8",
                        "X-Upload-Content-Type": "video/mp4",
                        "X-Upload-Content-Length": str(file_size),
                    },
                    json=body,
                )
                if init.status_code >= 400:
                    detail = init.text[:300]
                    try:
                        detail = init.json().get("error", {}).get("message") or detail
                    except Exception:  # noqa: BLE001
                        pass
                    raise YoutubeError(f"YouTube upload init: {detail}")

                upload_url = init.headers.get("location")
                if not upload_url:
                    raise YoutubeError("YouTube upload URL dönmedi")

                offset = 0
                with file_path.open("rb") as fh:
                    while offset < file_size:
                        chunk = fh.read(chunk_size)
                        if not chunk:
                            break
                        end = offset + len(chunk) - 1
                        put_headers = {
                            "Content-Length": str(len(chunk)),
                            "Content-Range": f"bytes {offset}-{end}/{file_size}",
                            "Content-Type": "video/mp4",
                        }

                        resp: httpx.Response | None = None
                        for chunk_try in range(1, 5):
                            try:
                                resp = client.put(
                                    upload_url, content=chunk, headers=put_headers
                                )
                                break
                            except httpx.HTTPError as exc:
                                last_error = exc
                                if chunk_try >= 4 or not _is_transient(exc):
                                    raise
                                time.sleep(0.6 * chunk_try)

                        assert resp is not None
                        if resp.status_code in {200, 201}:
                            data = resp.json()
                            video_id = data.get("id")
                            if not video_id:
                                raise YoutubeError("YouTube video id dönmedi")
                            if on_progress:
                                on_progress(1.0)
                            return {
                                "id": video_id,
                                "url": f"https://www.youtube.com/watch?v={video_id}",
                                "raw": data,
                            }

                        if resp.status_code == 308:
                            range_hdr = resp.headers.get("range") or resp.headers.get("Range")
                            if range_hdr and "-" in range_hdr:
                                try:
                                    offset = int(range_hdr.split("-")[1]) + 1
                                    fh.seek(offset)
                                except ValueError:
                                    offset = end + 1
                            else:
                                offset = end + 1
                            if on_progress:
                                on_progress(min(0.99, offset / file_size))
                            continue

                        if _is_transient(Exception(resp.text), resp.status_code) and attempt < 5:
                            last_error = YoutubeError(
                                f"HTTP {resp.status_code}: {resp.text[:200]}"
                            )
                            break  # retry whole upload from outer loop

                        raise YoutubeError(
                            f"YouTube chunk hatası HTTP {resp.status_code}: {resp.text[:300]}"
                        )
                    else:
                        raise YoutubeError("Upload beklenmedik şekilde sonlandı")

        except YoutubeError:
            raise
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < 5 and _is_transient(exc):
                time.sleep(0.8 * attempt)
                continue
            raise YoutubeError(f"YouTube yükleme hatası: {exc}") from exc

    raise YoutubeError(f"YouTube yükleme hatası: {last_error}")


def _thumbnail_error_message(detail: str) -> str:
    low = detail.lower()
    if "custom video thumbnails" in low or "custom thumbnail" in low or "permissions to upload and set" in low:
        return (
            "YouTube bu kanala özel kapak yüklemeye izin vermiyor. "
            "Kanalı doğrulayın: https://www.youtube.com/verify "
            "(telefon doğrulaması). Video yüklendi; kapak YouTube Studio’dan eklenebilir."
        )
    if "forbidden" in low or "403" in low:
        return (
            "Kapak için yetki yok. Kanal doğrulaması veya YouTube yeniden bağlama gerekebilir. "
            f"Detay: {detail[:160]}"
        )
    return f"Kapak yüklenemedi: {detail}"


def set_thumbnail(
    *,
    client_id: str,
    client_secret: str,
    refresh_token: str,
    video_id: str,
    image_path: Path,
) -> None:
    if not image_path.exists():
        raise YoutubeError("Kapak dosyası yok")
    data = image_path.read_bytes()
    if not data:
        raise YoutubeError("Kapak dosyası boş")

    last_error: BaseException | None = None
    for attempt in range(1, 5):
        try:
            # Fresh token + fresh TLS session each attempt (Windows SSL session bugs)
            token = refresh_access_token(client_id, client_secret, refresh_token)
            with httpx.Client(timeout=90.0, http2=False) as client:
                resp = client.post(
                    THUMB_UPLOAD_URL,
                    params={"videoId": video_id, "uploadType": "media"},
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "image/jpeg",
                        "Content-Length": str(len(data)),
                    },
                    content=data,
                )
            if resp.status_code >= 400:
                detail = resp.text[:300]
                try:
                    detail = resp.json().get("error", {}).get("message") or detail
                except Exception:  # noqa: BLE001
                    pass
                # Permission / channel-verify errors won't succeed on retry
                low = str(detail).lower()
                if "custom video thumbnails" in low or "permissions to upload" in low:
                    raise YoutubeError(_thumbnail_error_message(str(detail)))
                if _is_transient(Exception(detail), resp.status_code) and attempt < 4:
                    last_error = YoutubeError(detail)
                    time.sleep(0.7 * attempt)
                    continue
                raise YoutubeError(_thumbnail_error_message(str(detail)))
            return
        except YoutubeError:
            raise
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < 4 and _is_transient(exc):
                time.sleep(0.7 * attempt)
                continue
            raise YoutubeError(_thumbnail_error_message(str(exc))) from exc
    raise YoutubeError(_thumbnail_error_message(str(last_error)))
