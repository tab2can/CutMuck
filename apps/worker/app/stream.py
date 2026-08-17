from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

from .ffmpeg_util import FFmpegError, run_ffmpeg
from .kick import (
    KickError,
    fetch_hls_bytes,
    pick_media_playlist,
    slice_media_playlist_range,
)


class DownloadError(Exception):
    pass


ProgressCb = Callable[[float], None]

_HLS_HEADERS_FLAG = "Referer: https://kick.com/\r\nOrigin: https://kick.com/\r\n"


def _which(cmd: str) -> str | None:
    found = shutil.which(cmd)
    if found:
        return found
    bindir = Path(sys.executable).resolve().parent
    for name in (cmd, f"{cmd}.exe"):
        candidate = bindir / name
        if candidate.exists():
            return str(candidate)
    return None


def _fmt_hms(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds - h * 3600 - m * 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def _hls_attr_uri(line: str) -> str | None:
    key = "URI="
    i = line.upper().find(key)
    if i < 0:
        return None
    rest = line[i + 4 :]
    if rest.startswith('"'):
        end = rest.find('"', 1)
        return rest[1:end] if end > 0 else None
    return rest.split(",", 1)[0].strip() or None


def _load_media_playlist(hls_url: str) -> tuple[str, str]:
    raw, _ = fetch_hls_bytes(hls_url, 25.0)
    text = raw.decode("utf-8", errors="replace")
    if "#EXT-X-STREAM-INF" in text:
        media_url = pick_media_playlist(text, hls_url, prefer="best")
        raw, _ = fetch_hls_bytes(media_url, 45.0)
        text = raw.decode("utf-8", errors="replace")
        return text, media_url
    return text, hls_url


def _playlist_asset_urls(playlist: str) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for raw in playlist.splitlines():
        line = raw.strip()
        uri: str | None = None
        if line.startswith("#EXT-X-MAP:") or line.startswith("#EXT-X-KEY:"):
            uri = _hls_attr_uri(line)
            if uri and (uri.startswith("skd:") or uri.startswith("data:")):
                uri = None
        elif line and not line.startswith("#"):
            uri = line
        if not uri or uri in seen:
            continue
        seen.add(uri)
        urls.append(uri)
    return urls


def _rewrite_playlist_local(playlist: str, mapping: dict[str, str]) -> str:
    out: list[str] = []
    for raw in playlist.splitlines():
        line = raw.strip()
        if line.startswith("#EXT-X-MAP:") or line.startswith("#EXT-X-KEY:"):
            uri = _hls_attr_uri(line)
            local = mapping.get(uri or "")
            if uri and local:
                if f'URI="{uri}"' in raw:
                    raw = raw.replace(f'URI="{uri}"', f'URI="{local}"')
                else:
                    raw = raw.replace(uri, local)
            out.append(raw)
            continue
        if line and not line.startswith("#") and line in mapping:
            out.append(mapping[line])
            continue
        out.append(raw)
    return "\n".join(out) + "\n"


def _download_asset(url: str, dest: Path) -> None:
    last: BaseException | None = None
    for attempt in range(1, 4):
        try:
            raw, _ = fetch_hls_bytes(url, 90.0)
            dest.write_bytes(raw)
            if dest.stat().st_size > 0:
                return
            last = DownloadError("boş segment")
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.35 * attempt)
    raise DownloadError(f"Segment indirilemedi: {last}")


def download_segment_parallel_hls(
    hls_url: str,
    output: Path,
    start_sec: float,
    end_sec: float,
    on_progress: ProgressCb | None = None,
) -> Path:
    """Slice the HLS window, pull segments in parallel, remux with stream copy."""
    ffmpeg = _which("ffmpeg")
    if not ffmpeg:
        raise DownloadError("FFmpeg bulunamadı")
    duration = end_sec - start_sec
    if duration <= 0:
        raise DownloadError("Bitiş, başlangıçtan büyük olmalı")

    try:
        text, media_url = _load_media_playlist(hls_url)
        sliced, offset = slice_media_playlist_range(text, media_url, start_sec, end_sec)
    except KickError as exc:
        raise DownloadError(str(exc)) from exc

    urls = _playlist_asset_urls(sliced)
    if not urls:
        raise DownloadError("Playlistte indirilecek segment yok")

    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    work = Path(tempfile.mkdtemp(prefix="cutmuck-hls-"))
    mapping: dict[str, str] = {}
    try:
        for i, url in enumerate(urls):
            suffix = Path(urlparse(url).path).suffix or ".bin"
            if len(suffix) > 8:
                suffix = ".bin"
            mapping[url] = f"a{i:04d}{suffix}"

        total = len(urls)
        done = 0

        def _one(url: str) -> None:
            _download_asset(url, work / mapping[url])

        workers = min(16, max(4, total))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_one, url) for url in urls]
            for fut in as_completed(futures):
                fut.result()
                done += 1
                if on_progress:
                    on_progress(min(0.92, done / max(1, total) * 0.92))

        local_pl = work / "index.m3u8"
        local_pl.write_text(_rewrite_playlist_local(sliced, mapping), encoding="utf-8")

        base_cmd = [
            ffmpeg,
            "-y",
            "-allowed_extensions",
            "ALL",
            "-protocol_whitelist",
            "file,crypto,data",
            "-ss",
            f"{offset:.3f}",
            "-i",
            str(local_pl),
            "-t",
            f"{duration:.3f}",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
        ]
        last_err = ""
        for extra in (["-bsf:a", "aac_adtstoasc"], []):
            try:
                if output.exists():
                    output.unlink()
                run_ffmpeg(
                    [*base_cmd, *extra, str(output)],
                    duration=duration,
                    on_progress=(
                        (lambda frac: on_progress(0.92 + frac * 0.08)) if on_progress else None
                    ),
                )
                if output.exists() and output.stat().st_size > 1024:
                    if on_progress:
                        on_progress(1.0)
                    return output
            except FFmpegError as exc:
                last_err = str(exc)
                continue
        raise DownloadError(last_err or "HLS remux boş çıktı")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def download_segment_streamlink(
    url: str,
    output: Path,
    start_sec: float,
    end_sec: float,
    quality: str = "best",
    on_progress: ProgressCb | None = None,
) -> Path:
    streamlink = _which("streamlink")
    if not streamlink:
        raise DownloadError("Streamlink bulunamadı")
    if end_sec <= start_sec:
        raise DownloadError("Bitiş, başlangıçtan büyük olmalı")
    duration = end_sec - start_sec
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    cmd = [
        streamlink,
        "--force",
        "--retry-streams",
        "5",
        "--retry-max",
        "5",
        "--stream-timeout",
        "300",
        "--hls-segment-timeout",
        "120",
        "--hls-segment-attempts",
        "10",
        "--stream-segment-threads",
        "8",
        "--hls-start-offset",
        _fmt_hms(start_sec),
        "--hls-duration",
        _fmt_hms(duration),
        "-o",
        str(output),
        url,
        quality,
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.stdout is not None
    log: list[str] = []
    for line in proc.stdout:
        log.append(line)
        if on_progress and output.exists():
            expect = max(1.0, duration * 1_000_000)
            frac = min(0.95, output.stat().st_size / expect)
            on_progress(frac)
    code = proc.wait()
    if code != 0 or not output.exists() or output.stat().st_size < 1024:
        text = "".join(log[-40:]).strip()
        raise DownloadError(text or "Streamlink kesit indirme başarısız")
    if on_progress:
        on_progress(1.0)
    return output


def download_segment_ffmpeg(
    hls_url: str,
    output: Path,
    start_sec: float,
    end_sec: float,
    on_progress: ProgressCb | None = None,
) -> Path:
    ffmpeg = _which("ffmpeg")
    if not ffmpeg:
        raise DownloadError("FFmpeg bulunamadı")
    if end_sec <= start_sec:
        raise DownloadError("Bitiş, başlangıçtan büyük olmalı")
    duration = end_sec - start_sec
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    work = Path(tempfile.mkdtemp(prefix="cutmuck-ffhls-"))
    try:
        try:
            text, media_url = _load_media_playlist(hls_url)
            sliced, offset = slice_media_playlist_range(text, media_url, start_sec, end_sec)
        except KickError as exc:
            raise DownloadError(str(exc)) from exc
        pl = work / "index.m3u8"
        pl.write_text(sliced, encoding="utf-8")
        cmd_copy = [
            ffmpeg,
            "-y",
            "-headers",
            _HLS_HEADERS_FLAG,
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "5",
            "-protocol_whitelist",
            "file,http,https,tcp,tls,crypto",
            "-allowed_extensions",
            "ALL",
            "-ss",
            f"{offset:.3f}",
            "-i",
            str(pl),
            "-t",
            f"{duration:.3f}",
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-movflags",
            "+faststart",
            str(output),
        ]
        run_ffmpeg(cmd_copy, duration=duration, on_progress=on_progress)
        if output.exists() and output.stat().st_size > 1024:
            return output
    except (DownloadError, FFmpegError) as exc:
        if output.exists():
            try:
                output.unlink()
            except OSError:
                pass
        raise DownloadError(str(exc) or "FFmpeg kesit indirme başarısız") from exc
    finally:
        shutil.rmtree(work, ignore_errors=True)
    raise DownloadError("FFmpeg copy boş çıktı")


def download_segment(
    *,
    page_url: str,
    hls_url: str | None,
    output: Path,
    start_sec: float,
    end_sec: float,
    quality: str = "best",
    on_progress: ProgressCb | None = None,
) -> tuple[Path, str]:
    """Download [start, end] as remux (no re-encode). Parallel HLS first — not realtime."""
    errors: list[str] = []
    if hls_url:
        try:
            path = download_segment_parallel_hls(
                hls_url, output, start_sec, end_sec, on_progress=on_progress
            )
            return path, "hls-parallel"
        except DownloadError as exc:
            errors.append(f"parallel: {exc}")
        try:
            path = download_segment_ffmpeg(
                hls_url, output, start_sec, end_sec, on_progress=on_progress
            )
            return path, "ffmpeg-hls"
        except DownloadError as exc:
            errors.append(f"ffmpeg: {exc}")
    try:
        path = download_segment_streamlink(
            page_url, output, start_sec, end_sec, quality=quality, on_progress=on_progress
        )
        return path, "streamlink-segment"
    except DownloadError as exc:
        errors.append(f"streamlink: {exc}")
    raise DownloadError(" | ".join(errors) or "Kesit indirilemedi")


def download_with_streamlink(url: str, output: Path, quality: str = "best") -> Path:
    streamlink = _which("streamlink")
    if not streamlink:
        raise DownloadError("Streamlink bulunamadı")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    cmd = [
        streamlink,
        "--force",
        "--retry-streams",
        "3",
        "--stream-timeout",
        "300",
        "--stream-segment-threads",
        "8",
        "-o",
        str(output),
        url,
        quality,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not output.exists() or output.stat().st_size < 1024:
        raise DownloadError(proc.stderr.strip() or proc.stdout.strip() or "Streamlink indirme başarısız")
    return output
