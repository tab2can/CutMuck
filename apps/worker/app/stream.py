from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path


class DownloadError(Exception):
    pass


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


def download_segment_streamlink(
    url: str,
    output: Path,
    start_sec: float,
    end_sec: float,
    quality: str = "best",
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
        "--hls-start-offset",
        _fmt_hms(start_sec),
        "--hls-duration",
        _fmt_hms(duration),
        "-o",
        str(output),
        url,
        quality,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not output.exists() or output.stat().st_size < 1024:
        raise DownloadError(proc.stderr.strip() or proc.stdout.strip() or "Streamlink kesit indirme başarısız")
    return output


def download_segment_ffmpeg(
    hls_url: str,
    output: Path,
    start_sec: float,
    end_sec: float,
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
    # Seek in input for HLS efficiency, then remux/encode
    cmd_copy = [
        ffmpeg,
        "-y",
        "-headers",
        "Referer: https://kick.com/\r\nOrigin: https://kick.com\r\n",
        "-ss",
        f"{start_sec:.3f}",
        "-i",
        hls_url,
        "-t",
        f"{duration:.3f}",
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        str(output),
    ]
    proc = subprocess.run(cmd_copy, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode == 0 and output.exists() and output.stat().st_size > 1024:
        return output
    cmd_enc = [
        ffmpeg,
        "-y",
        "-headers",
        "Referer: https://kick.com/\r\nOrigin: https://kick.com\r\n",
        "-ss",
        f"{start_sec:.3f}",
        "-i",
        hls_url,
        "-t",
        f"{duration:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "22",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output),
    ]
    proc2 = subprocess.run(cmd_enc, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc2.returncode != 0 or not output.exists() or output.stat().st_size < 1024:
        raise DownloadError(proc2.stderr.strip() or proc.stderr.strip() or "FFmpeg kesit indirme başarısız")
    return output


def download_segment(
    *,
    page_url: str,
    hls_url: str | None,
    output: Path,
    start_sec: float,
    end_sec: float,
    quality: str = "best",
) -> tuple[Path, str]:
    """Download only [start, end] at best quality. Prefer streamlink, then ffmpeg HLS."""
    errors: list[str] = []
    try:
        path = download_segment_streamlink(page_url, output, start_sec, end_sec, quality=quality)
        return path, "streamlink-segment"
    except DownloadError as exc:
        errors.append(f"streamlink: {exc}")
    if hls_url:
        try:
            path = download_segment_ffmpeg(hls_url, output, start_sec, end_sec)
            return path, "ffmpeg-hls"
        except DownloadError as exc:
            errors.append(f"ffmpeg: {exc}")
    raise DownloadError(" | ".join(errors))


# Legacy full-download helpers kept for optional use
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
        "-o",
        str(output),
        url,
        quality,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not output.exists() or output.stat().st_size < 1024:
        raise DownloadError(proc.stderr.strip() or proc.stdout.strip() or "Streamlink indirme başarısız")
    return output


_PROGRESS_RE = re.compile(r"(\d+(?:\.\d+)?)%")
