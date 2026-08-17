from __future__ import annotations

from typing import Any
from urllib.parse import urljoin, urlparse

from curl_cffi import requests as cffi_requests

KICK_BASE = "https://kick.com"


class KickError(Exception):
    pass


def _get_json(path: str) -> Any:
    url = f"{KICK_BASE}{path}"
    try:
        resp = cffi_requests.get(
            url,
            impersonate="chrome",
            headers={
                "Accept": "application/json",
                "Referer": "https://kick.com/",
            },
            timeout=30,
        )
    except Exception as exc:  # noqa: BLE001
        raise KickError(f"Kick isteği başarısız: {exc}") from exc
    if resp.status_code == 404:
        raise KickError("Kanal veya video bulunamadı")
    if resp.status_code >= 400:
        raise KickError(f"Kick API hatası ({resp.status_code})")
    return resp.json()


def _flag_true(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "live"}
    return False


def _is_live_payload(livestream: Any) -> bool:
    """Only treat as live when Kick explicitly says so (stale livestream objects stay offline)."""
    if not livestream:
        return False
    if not isinstance(livestream, dict):
        return _flag_true(livestream)
    if "is_live" in livestream:
        return _flag_true(livestream.get("is_live"))
    session = livestream.get("session") or {}
    if isinstance(session, dict) and "is_live" in session:
        return _flag_true(session.get("is_live"))
    # Leftover id/title/url without is_live must not show CANLI
    return False


def fetch_channel(slug: str) -> dict[str, Any]:
    data = _get_json(f"/api/v2/channels/{slug}")
    user = data.get("user") or {}
    livestream = data.get("livestream")
    banner = None
    if isinstance(data.get("banner_image"), dict):
        banner = data["banner_image"].get("url")
    elif isinstance(data.get("banner_image"), str):
        banner = data.get("banner_image")
    return {
        "slug": data.get("slug") or slug,
        "display_name": user.get("username") or data.get("slug") or slug,
        "avatar_url": user.get("profile_pic"),
        "banner_url": banner,
        "is_live": _is_live_payload(livestream),
        "bio": user.get("bio"),
        "followers": data.get("followers_count"),
        "raw": data,
    }


def _ms_to_sec(value: Any) -> float:
    try:
        raw = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    # Kick durations are milliseconds
    return raw / 1000.0 if raw > 0 else 0.0


def fetch_vod_playback(uuid: str) -> dict[str, Any]:
    """Resolve HLS master URL + metadata for a Kick VOD uuid."""
    data = _get_json(f"/api/v1/video/{uuid}")
    livestream = data.get("livestream") or {}
    source = data.get("source") or livestream.get("source")
    if not source:
        raise KickError("Bu VOD için HLS kaynağı bulunamadı")
    duration = _ms_to_sec(livestream.get("duration") or data.get("duration"))
    title = livestream.get("session_title") or data.get("slug") or "Kick VOD"
    thumb = livestream.get("thumbnail")
    if isinstance(thumb, dict):
        thumb = thumb.get("src") or thumb.get("url")
    return {
        "uuid": data.get("uuid") or uuid,
        "hls_url": source,
        "duration": duration,
        "title": title,
        "thumbnail": thumb or data.get("thumb"),
        "is_live": bool(livestream.get("is_live")),
        "raw": data,
    }


def parse_vod_uuid(vod_url: str) -> str | None:
    path = urlparse(vod_url).path.strip("/")
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 3 and parts[1] == "videos":
        return parts[2]
    if len(parts) == 1 and "-" in parts[0]:
        return parts[0]
    return None


def fetch_vods(slug: str, limit: int = 40) -> list[dict[str, Any]]:
    data = _get_json(f"/api/v2/channels/{slug}/videos")
    items = data if isinstance(data, list) else data.get("data") or data.get("videos") or []
    vods: list[dict[str, Any]] = []
    for item in items[:limit]:
        video = item.get("video") or {}
        uuid = video.get("uuid") or item.get("video_uuid") or item.get("uuid")
        thumb = item.get("thumbnail") or {}
        thumb_url = thumb.get("src") if isinstance(thumb, dict) else thumb
        session_title = item.get("session_title") or item.get("title") or "Kick VOD"
        duration = _ms_to_sec(item.get("duration"))
        is_live = bool(item.get("is_live"))
        vod_url = f"https://kick.com/{slug}/videos/{uuid}" if uuid else None
        hls = item.get("source")
        vods.append(
            {
                "id": str(item.get("id") or uuid),
                "uuid": uuid,
                "title": session_title,
                "duration": duration,
                "views": item.get("views") or video.get("views") or 0,
                "created_at": item.get("created_at") or item.get("start_time"),
                "thumbnail": thumb_url,
                "is_live": is_live,
                "url": vod_url,
                "hls_url": hls,
                "language": item.get("language"),
            }
        )
    live = [v for v in vods if v["is_live"]]
    past = [v for v in vods if not v["is_live"]]
    return live + past


def fetch_clips(slug: str, limit: int = 24) -> list[dict[str, Any]]:
    try:
        data = _get_json(f"/api/v2/channels/{slug}/clips?cursor=0&sort=view")
    except KickError:
        return []
    items = data.get("clips") if isinstance(data, dict) else data
    if not isinstance(items, list):
        items = data.get("data") if isinstance(data, dict) else []
    clips: list[dict[str, Any]] = []
    for item in (items or [])[:limit]:
        clip_id = item.get("id") or item.get("clip_id")
        duration = item.get("duration") or 0
        try:
            duration = float(duration)
            if duration > 1000:
                duration = duration / 1000.0
        except (TypeError, ValueError):
            duration = 0.0
        clips.append(
            {
                "id": str(clip_id),
                "title": item.get("title") or "Klip",
                "views": item.get("views") or item.get("view_count") or 0,
                "duration": duration,
                "thumbnail": item.get("thumbnail_url") or item.get("thumbnail"),
                "created_at": item.get("created_at"),
                "url": f"https://kick.com/{slug}?clip={clip_id}" if clip_id else None,
                "video_url": item.get("video_url") or item.get("clip_url"),
            }
        )
    return clips


def fetch_clip_playback(clip_id: str) -> dict[str, Any]:
    """Resolve HLS/MP4 source for a Kick clip id."""
    data = _get_json(f"/api/v2/clips/{clip_id}")
    clip = data.get("clip") if isinstance(data, dict) and "clip" in data else data
    if not isinstance(clip, dict):
        raise KickError("Klip bulunamadı")
    video_url = (
        clip.get("video_url")
        or clip.get("clip_url")
        or clip.get("source")
        or (clip.get("video") or {}).get("url")
    )
    if not video_url:
        raise KickError("Bu klip için oynatma kaynağı yok")
    duration = clip.get("duration") or 0
    try:
        duration = float(duration)
        if duration > 1000:
            duration = duration / 1000.0
    except (TypeError, ValueError):
        duration = 0.0
    thumb = clip.get("thumbnail_url") or clip.get("thumbnail")
    channel = clip.get("channel") or {}
    slug = channel.get("slug") or ""
    return {
        "id": str(clip.get("id") or clip_id),
        "hls_url": video_url,
        "duration": duration,
        "title": clip.get("title") or "Klip",
        "thumbnail": thumb,
        "url": f"https://kick.com/{slug}?clip={clip_id}" if slug else None,
        "channel_slug": slug or None,
        "raw": clip,
    }


def fetch_live_playback(slug: str) -> dict[str, Any]:
    """Resolve live HLS like Kick: growing session DVR for history + edge for fallback."""
    data = _get_json(f"/api/v2/channels/{slug}")
    livestream = data.get("livestream")
    if not livestream:
        raise KickError("Kanal şu an canlı değil")

    edge = livestream.get("playback_url") or data.get("playback_url")
    if not edge:
        session = livestream.get("session") or {}
        edge = session.get("playback_url") or session.get("source")

    session_hls = livestream.get("source")
    vod_uuid = (
        livestream.get("video_uuid")
        or (livestream.get("video") or {}).get("uuid")
    )

    # Kick often omits livestream.source — the live VOD entry holds the full EVENT DVR.
    if not session_hls:
        try:
            for item in fetch_vods(slug, limit=12):
                if not item.get("is_live"):
                    continue
                if item.get("hls_url"):
                    session_hls = item["hls_url"]
                    vod_uuid = item.get("uuid") or vod_uuid
                    break
                if item.get("uuid"):
                    vod_uuid = item.get("uuid") or vod_uuid
                    break
        except KickError:
            pass

    if not session_hls and vod_uuid:
        try:
            vod = fetch_vod_playback(str(vod_uuid))
            session_hls = vod.get("hls_url")
        except KickError:
            pass

    # Full session DVR first (same as Kick rewind); edge is short sliding window only
    hls_url = session_hls or edge
    if not hls_url:
        raise KickError("Canlı HLS kaynağı bulunamadı")

    thumb = livestream.get("thumbnail")
    if isinstance(thumb, dict):
        thumb = thumb.get("url") or thumb.get("src")
    title = livestream.get("session_title") or f"{slug} canlı"
    return {
        "hls_url": hls_url,
        "live_edge_url": edge or hls_url,
        "dvr_hls_url": session_hls or hls_url,
        "dvr": bool(session_hls),
        "vod_uuid": vod_uuid,
        "title": title,
        "thumbnail": thumb,
        "livestream_id": livestream.get("id"),
        "url": f"https://kick.com/{slug}",
        "raw": livestream,
    }


def fetch_hls_bytes(url: str, timeout: float = 20.0) -> tuple[bytes, str]:
    """Fetch HLS playlist or small asset with browser impersonation."""
    try:
        resp = cffi_requests.get(
            url,
            impersonate="chrome",
            headers={
                "Referer": "https://kick.com/",
                "Origin": "https://kick.com",
                "Accept": "*/*",
            },
            timeout=timeout,
        )
    except Exception as exc:  # noqa: BLE001
        raise KickError(f"HLS isteği başarısız: {exc}") from exc
    if resp.status_code >= 400:
        raise KickError(f"HLS hatası ({resp.status_code})")
    content_type = resp.headers.get("content-type") or "application/octet-stream"
    return resp.content, content_type


def pick_media_playlist(master_text: str, master_url: str, prefer: str = "720") -> str:
    """Pick a single rendition. prefer: 360|480|720|1080|best."""
    base = master_url.rsplit("/", 1)[0] + "/"
    prefer = (prefer or "720").lower()
    lines = [ln.strip() for ln in master_text.splitlines()]
    candidates: list[tuple[int, int, str]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-STREAM-INF:"):
            meta = line.lower()
            bw = 0
            if "bandwidth=" in meta:
                try:
                    bw = int(meta.split("bandwidth=")[1].split(",")[0])
                except ValueError:
                    bw = 0
            height = 0
            if "resolution=" in meta:
                try:
                    res = meta.split("resolution=")[1].split(",")[0]
                    height = int(res.split("x")[1])
                except (ValueError, IndexError):
                    height = 0
            if not height:
                for label, h in (("1080", 1080), ("720", 720), ("480", 480), ("360", 360)):
                    if label in meta:
                        height = h
                        break
            j = i + 1
            while j < len(lines) and (not lines[j] or lines[j].startswith("#")):
                j += 1
            if j < len(lines):
                candidates.append((height, bw, urljoin(base, lines[j])))
            i = j + 1
            continue
        i += 1
    if not candidates:
        raise KickError("Master playlist içinde kalite seçeneği yok")

    if prefer == "best":
        candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
        return candidates[0][2]

    matched: list[tuple[int, int, str]] = []
    for h, bw, url in candidates:
        if prefer in url.lower() or (prefer.isdigit() and h == int(prefer)):
            matched.append((h, bw, url))
    if matched:
        matched.sort(key=lambda x: (x[0], x[1]), reverse=True)
        return matched[0][2]

    want = int(prefer) if prefer.isdigit() else 720
    below = [c for c in candidates if c[0] and c[0] <= want]
    pool = below or candidates
    pool.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return pool[0][2]


def normalize_vod_playlist(content: str) -> str:
    """Kick serves finished VODs as EVENT; force VOD so hls.js can seek/play reliably."""
    lines = content.splitlines()
    out: list[str] = []
    has_endlist = False
    for raw in lines:
        line = raw.strip()
        if line.startswith("#EXT-X-PLAYLIST-TYPE:"):
            out.append("#EXT-X-PLAYLIST-TYPE:VOD")
            continue
        if line == "#EXT-X-ENDLIST":
            has_endlist = True
        out.append(raw)
    if not has_endlist:
        out.append("#EXT-X-ENDLIST")
    return "\n".join(out) + "\n"


def ensure_live_playlist(content: str) -> str:
    """Keep playlists sliding/live: never freeze with ENDLIST/VOD type."""
    out: list[str] = []
    for raw in content.splitlines():
        line = raw.strip()
        if line == "#EXT-X-ENDLIST":
            continue
        if line.startswith("#EXT-X-PLAYLIST-TYPE:"):
            out.append("#EXT-X-PLAYLIST-TYPE:EVENT")
            continue
        out.append(raw)
    return "\n".join(out) + "\n"

def trim_live_media_playlist(content: str, max_segments: int = 18) -> str:
    """Keep only the newest N segments so hls.js joins near the live edge quickly."""
    if max_segments <= 0 or "#EXTINF" not in content:
        return content

    lines = content.splitlines()
    header: list[str] = []
    media_seq_idx: int | None = None
    media_seq_val = 0
    segments: list[list[str]] = []
    current: list[str] = []
    saw_inf = False

    def flush() -> None:
        nonlocal current, saw_inf
        if saw_inf and current:
            segments.append(current)
        current = []
        saw_inf = False

    for raw in lines:
        line = raw.strip()
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                media_seq_val = int(line.split(":", 1)[1].strip())
            except ValueError:
                media_seq_val = 0
            header.append(raw)
            media_seq_idx = len(header) - 1
            continue
        if line.startswith("#EXTINF"):
            if saw_inf:
                flush()
            saw_inf = True
            current.append(raw)
            continue
        if saw_inf:
            current.append(raw)
            if line and not line.startswith("#"):
                flush()
            continue
        if segments:
            continue
        header.append(raw)

    flush()
    if len(segments) <= max_segments:
        return content

    dropped = len(segments) - max_segments
    kept = segments[dropped:]
    if media_seq_idx is not None:
        header[media_seq_idx] = f"#EXT-X-MEDIA-SEQUENCE:{media_seq_val + dropped}"
    out: list[str] = list(header)
    for seg in kept:
        out.extend(seg)
    return "\n".join(out) + "\n"


def playlist_duration_seconds(content: str) -> float:
    """Sum #EXTINF durations in a media playlist."""
    total = 0.0
    for raw in content.splitlines():
        line = raw.strip()
        if not line.startswith("#EXTINF:"):
            continue
        try:
            total += float(line.split(":", 1)[1].split(",", 1)[0])
        except ValueError:
            continue
    return total


def _hls_attr_uri(line: str) -> str | None:
    key = "URI="
    lower = line.upper()
    i = lower.find(key)
    if i < 0:
        return None
    rest = line[i + 4 :]
    if rest.startswith('"'):
        end = rest.find('"', 1)
        return rest[1:end] if end > 0 else None
    return rest.split(",", 1)[0].strip() or None


def _absolutize_hls_line(raw: str, base: str) -> str:
    line = raw.strip()
    if line.startswith("#EXT-X-MAP:") or line.startswith("#EXT-X-KEY:"):
        uri = _hls_attr_uri(line)
        if uri and not uri.startswith("data:"):
            abs_u = urljoin(base, uri)
            if abs_u != uri:
                if f'URI="{uri}"' in raw:
                    return raw.replace(f'URI="{uri}"', f'URI="{abs_u}"')
                if f"URI={uri}" in raw:
                    return raw.replace(f"URI={uri}", f'URI="{abs_u}"')
        return raw
    if line and not line.startswith("#"):
        return urljoin(base, line)
    return raw


def slice_media_playlist_range(
    content: str,
    playlist_url: str,
    start_sec: float,
    end_sec: float,
) -> tuple[str, float]:
    """Keep only segments covering [start, end]; force VOD+ENDLIST; absolutize URIs.

    Returns (playlist_text, offset_into_first_segment) so ffmpeg -ss can trim.
    Raises KickError if the playlist uses byte ranges (need a different downloader).
    """
    if end_sec <= start_sec:
        raise KickError("Bitiş, başlangıçtan büyük olmalı")
    if "#EXT-X-BYTERANGE" in content:
        raise KickError("byterange playlist")

    base = playlist_url.rsplit("/", 1)[0] + "/"
    lines = content.splitlines()
    header: list[str] = []
    segments: list[list[str]] = []
    durations: list[float] = []
    current: list[str] = []
    saw_inf = False
    pending: list[str] = []

    def flush() -> None:
        nonlocal current, saw_inf
        if saw_inf and current:
            dur = 0.0
            for raw in current:
                s = raw.strip()
                if s.startswith("#EXTINF:"):
                    try:
                        dur = float(s.split(":", 1)[1].split(",", 1)[0])
                    except ValueError:
                        dur = 0.0
                    break
            segments.append(current)
            durations.append(dur)
        current = []
        saw_inf = False

    for raw in lines:
        line = raw.strip()
        if line == "#EXT-X-ENDLIST":
            continue
        if line.startswith("#EXTINF"):
            if saw_inf:
                flush()
            if pending:
                current.extend(pending)
                pending = []
            saw_inf = True
            current.append(raw)
            continue
        if saw_inf:
            current.append(raw)
            if line and not line.startswith("#"):
                flush()
            continue
        if line.startswith("#EXT-X-MAP:") or line.startswith("#EXT-X-KEY:") or line.startswith("#EXT-X-DISCONTINUITY"):
            pending.append(raw)
            continue
        if segments:
            continue
        header.append(raw)

    flush()
    if not segments:
        raise KickError("Medya playlistinde segment yok")

    start_sec = max(0.0, float(start_sec))
    end_sec = float(end_sec)
    t = 0.0
    first_i: int | None = None
    last_i = 0
    first_offset = 0.0
    for i, dur in enumerate(durations):
        seg_end = t + max(dur, 0.001)
        if first_i is None and seg_end > start_sec:
            first_i = i
            first_offset = max(0.0, start_sec - t)
        if t < end_sec:
            last_i = i
        t = seg_end
        if t >= end_sec and first_i is not None:
            break

    if first_i is None:
        raise KickError("Kesit aralığı playlist dışında")

    # One extra segment of lead-in helps copy-mode keyframe trim.
    lead = max(0, first_i - 1)
    if lead < first_i:
        first_offset += sum(durations[lead:first_i])
        first_i = lead

    kept = segments[first_i : last_i + 1]
    out_header: list[str] = []
    has_type = False
    has_seq = False
    for raw in header:
        line = raw.strip()
        if line.startswith("#EXT-X-PLAYLIST-TYPE:"):
            out_header.append("#EXT-X-PLAYLIST-TYPE:VOD")
            has_type = True
            continue
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            out_header.append("#EXT-X-MEDIA-SEQUENCE:0")
            has_seq = True
            continue
        out_header.append(_absolutize_hls_line(raw, base))
    if not has_type:
        out_header.append("#EXT-X-PLAYLIST-TYPE:VOD")
    if not has_seq:
        out_header.append("#EXT-X-MEDIA-SEQUENCE:0")

    last_map: str | None = None
    last_key: str | None = None
    for prev in segments[:first_i]:
        for raw in prev:
            s = raw.strip()
            if s.startswith("#EXT-X-MAP:"):
                last_map = raw
            elif s.startswith("#EXT-X-KEY:"):
                last_key = raw
    header_has_map = any(r.strip().startswith("#EXT-X-MAP:") for r in out_header)
    header_has_key = any(r.strip().startswith("#EXT-X-KEY:") for r in out_header)

    body: list[str] = list(out_header)
    if last_map and not header_has_map:
        body.append(_absolutize_hls_line(last_map, base))
    if last_key and not header_has_key:
        body.append(_absolutize_hls_line(last_key, base))
    for seg in kept:
        for raw in seg:
            body.append(_absolutize_hls_line(raw, base))
    body.append("#EXT-X-ENDLIST")
    return "\n".join(body) + "\n", first_offset

