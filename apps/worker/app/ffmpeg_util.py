from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .config import settings


class FFmpegError(Exception):
    pass


def _ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise FFmpegError("FFmpeg PATH üzerinde bulunamadı")
    return path


def _ffprobe() -> str:
    path = shutil.which("ffprobe")
    if not path:
        raise FFmpegError("ffprobe PATH üzerinde bulunamadı")
    return path


def _ffmpeg_threads() -> int:
    return max(1, int(getattr(settings, "ffmpeg_threads", 0) or 1))


def _x264_thread_args() -> list[str]:
    return ["-threads", str(_ffmpeg_threads())]


def probe_duration(path: Path) -> float:
    cmd = [
        _ffprobe(),
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise FFmpegError(proc.stderr or "ffprobe başarısız")
    data = json.loads(proc.stdout or "{}")
    return float(data.get("format", {}).get("duration") or 0)


def _reencode_exact_duration(source: Path, dest: Path, duration: float) -> None:
    """Clean re-encode clipped to exact length — fixes bad HLS/copy timestamps."""
    if dest.exists():
        dest.unlink()
    duration = max(0.5, float(duration))
    cmd = [
        _ffmpeg(),
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        str(source),
        "-t",
        f"{duration:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        *_x264_thread_args(),
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    run_ffmpeg(cmd, duration=duration)


def ensure_clip_duration(path: Path, expected: float, *, label: str = "kesit") -> Path:
    """Reject or repair files whose probed duration doesn't match the In/Out window.

    Stream-copy HLS remux / concat can produce broken timestamps: players (and
    YouTube) then show a much longer, glitchy video. Re-encode when that happens.
    """
    expected = max(0.5, float(expected))
    try:
        got = probe_duration(path)
    except FFmpegError as exc:
        raise FFmpegError(f"{label} süresi okunamadı: {exc}") from exc
    if got < 0.5:
        raise FFmpegError(f"{label} boş veya bozuk")

    too_short = got < expected * 0.85 and (expected - got) > 25
    too_long = got > expected * 1.05 and (got - expected) > 15
    if not too_short and not too_long:
        return path

    if too_short:
        raise FFmpegError(
            f"{label} beklenenden kısa ({got:.0f}s / {expected:.0f}s) — tekrar deneyin"
        )

    fixed = path.with_name(f"{path.stem}_fix{path.suffix}")
    try:
        _reencode_exact_duration(path, fixed, expected)
        got2 = probe_duration(fixed)
    except FFmpegError as exc:
        if fixed.exists():
            try:
                fixed.unlink()
            except OSError:
                pass
        raise FFmpegError(
            f"{label} süre düzeltilemedi ({got:.0f}s → beklenen {expected:.0f}s): {exc}"
        ) from exc

    if got2 > expected * 1.08 and (got2 - expected) > 15:
        try:
            fixed.unlink()
        except OSError:
            pass
        raise FFmpegError(
            f"{label} hâlâ çok uzun ({got2:.0f}s / {expected:.0f}s) — tekrar deneyin"
        )

    try:
        path.unlink()
    except OSError:
        pass
    fixed.replace(path)
    return path


def prepare_for_youtube(path: Path, expected: float | None = None) -> Path:
    """Remux with genpts+faststart; re-encode if timestamps are still bad.

    Keeps stream-copy when possible (fast). Called right before YouTube upload.
    """
    if not path.exists() or path.stat().st_size < 1024:
        raise FFmpegError("YouTube için dosya yok veya boş")

    if expected and expected > 0.5:
        ensure_clip_duration(path, expected, label="YouTube kesit")

    remuxed = path.with_name(f"{path.stem}_yt{path.suffix}")
    if remuxed.exists():
        try:
            remuxed.unlink()
        except OSError:
            pass

    cmd_copy = [
        _ffmpeg(),
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        str(path),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(remuxed),
    ]
    try:
        run_ffmpeg(cmd_copy)
        ok = remuxed.exists() and remuxed.stat().st_size > 1024
    except FFmpegError:
        ok = False

    if ok and expected and expected > 0.5:
        try:
            ensure_clip_duration(remuxed, expected, label="YouTube remux")
        except FFmpegError:
            ok = False

    if ok:
        try:
            path.unlink()
        except OSError:
            pass
        remuxed.replace(path)
        return path

    if remuxed.exists():
        try:
            remuxed.unlink()
        except OSError:
            pass

    # Full re-encode — YouTube-safe H264/AAC
    dur = expected
    if not dur or dur < 0.5:
        try:
            dur = probe_duration(path)
        except FFmpegError:
            dur = None
    cmd_enc = [
        _ffmpeg(),
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        str(path),
    ]
    if dur and dur > 0.5:
        cmd_enc.extend(["-t", f"{dur:.3f}"])
    cmd_enc.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "23",
            *_x264_thread_args(),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(remuxed),
        ]
    )
    run_ffmpeg(cmd_enc, duration=dur)
    if not remuxed.exists() or remuxed.stat().st_size < 1024:
        raise FFmpegError("YouTube encode başarısız")
    try:
        path.unlink()
    except OSError:
        pass
    remuxed.replace(path)
    if expected and expected > 0.5:
        ensure_clip_duration(path, expected, label="YouTube encode")
    return path


def overlay_output_duration(clip_len: float, overlays: list[dict[str, Any]]) -> float:
    """Expected length after overlays (speed changes duration)."""
    speed = 1.0
    for ov in overlays:
        if ov.get("hidden"):
            continue
        if (ov.get("type") or "") == "speed":
            try:
                speed = float(ov.get("speed") or 1.0)
            except (TypeError, ValueError):
                speed = 1.0
            speed = max(0.5, min(2.0, speed))
    return max(0.5, float(clip_len) / speed)


def cut_media(source: Path, dest: Path, start_sec: float, end_sec: float) -> Path:
    if end_sec <= start_sec:
        raise FFmpegError("Bitiş, başlangıçtan büyük olmalı")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    duration = max(0.1, end_sec - start_sec)
    cmd_copy = [
        _ffmpeg(),
        "-y",
        "-ss",
        f"{start_sec:.3f}",
        "-i",
        str(source),
        "-t",
        f"{duration:.3f}",
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        str(dest),
    ]
    proc = subprocess.run(cmd_copy, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
        try:
            return ensure_clip_duration(dest, duration, label="kesit")
        except FFmpegError:
            try:
                dest.unlink()
            except OSError:
                pass
    cmd_enc = [
        _ffmpeg(),
        "-y",
        "-fflags",
        "+genpts",
        "-ss",
        f"{start_sec:.3f}",
        "-i",
        str(source),
        "-t",
        f"{duration:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        *_x264_thread_args(),
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    proc2 = subprocess.run(cmd_enc, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc2.returncode != 0 or not dest.exists():
        raise FFmpegError(proc2.stderr or proc.stderr or "Kesme başarısız")
    return ensure_clip_duration(dest, duration, label="kesit")


def _escape_drawtext(text: str) -> str:
    """Escape for drawtext inside a comma-joined -vf graph."""
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace(",", "\\,")
        .replace("%", "%%")
        .replace("\n", " ")
    )


_RGBA_RE = re.compile(
    r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)",
    re.IGNORECASE,
)


def _ffmpeg_color(value: str, *, default_alpha: float = 1.0) -> str:
    """
    Convert CSS/UI colors to ffmpeg form without commas.
    rgba(0,0,0,0.5) → 0x000000@0.50  (commas break -vf filter graphs)
    """
    raw = (value or "").strip()
    if not raw:
        return f"black@{max(0.0, min(1.0, default_alpha)):.2f}"

    m = _RGBA_RE.fullmatch(raw)
    if m:
        r = max(0, min(255, int(float(m.group(1)))))
        g = max(0, min(255, int(float(m.group(2)))))
        b = max(0, min(255, int(float(m.group(3)))))
        if m.group(4) is not None:
            a = max(0.0, min(1.0, float(m.group(4))))
        else:
            a = max(0.0, min(1.0, default_alpha))
        return f"0x{r:02x}{g:02x}{b:02x}@{a:.2f}"

    hexcol = raw.lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{8}", hexcol):
        a = int(hexcol[6:8], 16) / 255.0
        return f"0x{hexcol[:6]}@{a:.2f}"
    if re.fullmatch(r"[0-9a-fA-F]{6}", hexcol):
        return f"0x{hexcol}@{max(0.0, min(1.0, default_alpha)):.2f}"
    if re.fullmatch(r"[0-9a-fA-F]{3}", hexcol):
        expanded = "".join(ch * 2 for ch in hexcol)
        return f"0x{expanded}@{max(0.0, min(1.0, default_alpha)):.2f}"

    # Named color (white, black, …) — strip anything that could split the graph
    named = re.sub(r"[^a-zA-Z0-9_]", "", raw) or "white"
    return f"{named}@{max(0.0, min(1.0, default_alpha)):.2f}"


ProgressCb = Callable[[float], None]

_ENCODER_CACHE: list[str] | None = None
_FULL_FRAME_TYPES = {
    "speed",
    "brightness",
    "contrast",
    "saturate",
    "vignette",
    "blur",
    "sharpen",
    "noise",
    "grayscale",
    "sepia",
    "mirror",
    "letterbox",
    "tint",
}


def _parse_progress_time(line: str) -> float | None:
    if line.startswith("out_time_ms="):
        raw = line.split("=", 1)[1].strip()
        if raw.isdigit():
            return int(raw) / 1_000_000.0
    if line.startswith("out_time="):
        raw = line.split("=", 1)[1].strip()
        parts = raw.split(":")
        if len(parts) == 3:
            try:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
            except ValueError:
                return None
    return None


def run_ffmpeg(
    cmd: list[str],
    *,
    duration: float | None = None,
    on_progress: ProgressCb | None = None,
) -> None:
    """Run ffmpeg; parse -progress pipe:1 so long encodes don't look frozen."""
    extra = ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1"]
    full = [cmd[0], *extra, *cmd[1:]]
    proc = subprocess.Popen(
        full,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.stdout is not None
    err_chunks: list[str] = []

    def _drain_err() -> None:
        if proc.stderr:
            err_chunks.append(proc.stderr.read() or "")

    err_thread = threading.Thread(target=_drain_err, daemon=True)
    err_thread.start()
    last_frac = -1.0
    for line in proc.stdout:
        t = _parse_progress_time(line.strip())
        if t is None or duration is None or duration <= 0 or on_progress is None:
            continue
        frac = max(0.0, min(0.99, t / duration))
        if frac - last_frac >= 0.01:
            last_frac = frac
            on_progress(frac)
    code = proc.wait()
    err_thread.join(timeout=8)
    stderr = "".join(err_chunks)
    if code != 0:
        raise FFmpegError(stderr[-4000:] if stderr else "FFmpeg başarısız")
    if on_progress:
        on_progress(1.0)


def _encoder_candidates() -> list[list[str]]:
    """Prefer GPU encode when the box has NVENC/QSV; else ultrafast x264."""
    global _ENCODER_CACHE
    cpu = ["libx264", "-preset", "ultrafast", "-crf", "23", *_x264_thread_args()]
    if _ENCODER_CACHE is not None:
        return [_ENCODER_CACHE, cpu]

    try:
        out = subprocess.run(
            [_ffmpeg(), "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
        ).stdout
    except Exception:  # noqa: BLE001
        out = ""

    if "h264_nvenc" in out:
        _ENCODER_CACHE = [
            "h264_nvenc",
            "-preset",
            "p1",
            "-rc",
            "vbr",
            "-cq",
            "23",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
        ]
    elif "h264_qsv" in out:
        _ENCODER_CACHE = ["h264_qsv", "-preset", "veryfast", "-global_quality", "23"]
    else:
        _ENCODER_CACHE = cpu
    return [_ENCODER_CACHE, cpu]


def _needs_full_reencode(overlays: list[dict[str, Any]]) -> bool:
    for ov in overlays:
        if ov.get("hidden"):
            continue
        kind = ov.get("type") or "text"
        if kind in _FULL_FRAME_TYPES:
            return True
    return False


def _fade_head_tail(ov: dict[str, Any]) -> tuple[float, float]:
    """Seconds of real fade at clip start / end. Timeline span is ignored."""
    kind = ov.get("type") or "fadeblack"
    default_fade = 1.5 if kind == "fadeblack" else 0.0
    default_hold = 2.0 if kind == "fadeblack" else 0.0
    fade_in = max(0.0, float(ov.get("fade_in") or default_fade))
    fade_out = max(0.0, float(ov.get("fade_out") or default_fade))
    hold_in = float(ov.get("hold_in") if ov.get("hold_in") is not None else default_hold)
    hold_out = float(ov.get("hold_out") if ov.get("hold_out") is not None else default_hold)
    return max(0.0, hold_in + fade_in), max(0.0, hold_out + fade_out)


def _overlay_reencode_windows(
    overlays: list[dict[str, Any]], duration: float
) -> list[tuple[float, float]]:
    """Pixel-changing ranges only. Fade is drawn across the whole clip in the UI
    but only mutates the first/last few seconds — never the middle."""
    windows: list[tuple[float, float]] = []
    for ov in overlays:
        if ov.get("hidden"):
            continue
        kind = ov.get("type") or "text"
        if kind in {"fade", "fadeblack"}:
            head, tail = _fade_head_tail(ov)
            if head > 0.05:
                windows.append((0.0, min(duration, head)))
            if tail > 0.05:
                windows.append((max(0.0, duration - tail), duration))
        elif kind in {"text", "rect"}:
            start = float(ov.get("start_sec") or 0)
            end = float(ov.get("end_sec") if ov.get("end_sec") is not None else duration)
            windows.append((max(0.0, start), min(duration, end)))
    return windows


def _parse_frame_times(stdout: str) -> list[float]:
    try:
        data = json.loads(stdout or "{}")
    except json.JSONDecodeError:
        return []
    times: list[float] = []
    for fr in data.get("frames") or []:
        for key in ("best_effort_timestamp_time", "pkt_pts_time", "pts_time"):
            raw = fr.get(key)
            if raw is None:
                continue
            try:
                times.append(float(raw))
                break
            except (TypeError, ValueError):
                continue
    times.sort()
    return times


def _keyframe_times(path: Path, start: float, end: float) -> list[float]:
    start = max(0.0, start)
    end = max(start + 0.05, end)
    cmd = [
        _ffprobe(),
        "-v",
        "error",
        "-read_intervals",
        f"{start:.3f}%{end:.3f}",
        "-skip_frame",
        "nokey",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=best_effort_timestamp_time,pkt_pts_time,pts_time",
        "-of",
        "json",
        str(path),
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=25,
        )
    except (subprocess.TimeoutExpired, OSError):
        return []
    if proc.returncode != 0:
        return []
    return _parse_frame_times(proc.stdout)


def _kf_at_or_after(path: Path, t: float, duration: float) -> float:
    times = _keyframe_times(path, max(0.0, t - 0.2), min(duration, t + 8.0))
    for k in times:
        if k >= t - 0.05:
            return min(duration, k)
    return min(duration, t)


def _kf_at_or_before(path: Path, t: float) -> float:
    times = _keyframe_times(path, max(0.0, t - 8.0), t + 0.2)
    before = [k for k in times if k <= t + 0.05]
    return before[-1] if before else max(0.0, t)


def _snap_windows_to_keyframes(
    path: Path, windows: list[tuple[float, float]], duration: float
) -> list[tuple[float, float]]:
    snapped: list[tuple[float, float]] = []
    for a, b in windows:
        sa = 0.0 if a <= 0.08 else _kf_at_or_before(path, a)
        sb = duration if b >= duration - 0.08 else _kf_at_or_after(path, b, duration)
        if sb - sa >= 0.05:
            snapped.append((sa, min(duration, sb)))
    return _merge_windows(snapped, pad=0.0, duration=duration)


def probe_fps(path: Path) -> float | None:
    cmd = [
        _ffprobe(),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate,r_frame_rate",
        "-of",
        "json",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        return None
    try:
        stream = (json.loads(proc.stdout or "{}").get("streams") or [{}])[0]
    except (json.JSONDecodeError, IndexError):
        return None
    for key in ("avg_frame_rate", "r_frame_rate"):
        raw = str(stream.get(key) or "")
        if "/" not in raw:
            continue
        n_s, d_s = raw.split("/", 1)
        try:
            n, d = float(n_s), float(d_s)
        except ValueError:
            continue
        if d != 0 and 1.0 <= n / d <= 120.0:
            return n / d
    return None


def _compat_x264() -> list[str]:
    """x264 settings that concat cleanly with Kick/HLS stream-copied H264."""
    return [
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        *_x264_thread_args(),
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-x264-params",
        "repeat-headers=1:keyint=48:min-keyint=24:scenecut=0",
    ]


def _concat_copy(parts: list[Path], dest: Path, work: Path) -> None:
    if not parts:
        raise FFmpegError("birleştirilecek parça yok")
    list_file = work / "concat.txt"
    list_file.write_text(
        "".join(f"file '{p.as_posix()}'\n" for p in parts),
        encoding="utf-8",
    )
    try:
        run_ffmpeg(
            [
                _ffmpeg(),
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_file),
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(dest),
            ]
        )
        if dest.exists() and dest.stat().st_size > 1024:
            return
    except FFmpegError:
        if dest.exists():
            try:
                dest.unlink()
            except OSError:
                pass

    ts_parts: list[Path] = []
    for i, part in enumerate(parts):
        ts = work / f"c{i:03d}.ts"
        run_ffmpeg(
            [
                _ffmpeg(),
                "-y",
                "-i",
                str(part),
                "-c",
                "copy",
                "-bsf:v",
                "h264_mp4toannexb",
                "-f",
                "mpegts",
                str(ts),
            ]
        )
        ts_parts.append(ts)
    ts_list = work / "concat_ts.txt"
    ts_list.write_text(
        "".join(f"file '{p.as_posix()}'\n" for p in ts_parts),
        encoding="utf-8",
    )
    run_ffmpeg(
        [
            _ffmpeg(),
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(ts_list),
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-movflags",
            "+faststart",
            str(dest),
        ]
    )
    if not dest.exists() or dest.stat().st_size < 1024:
        raise FFmpegError("concat çıktısı boş")


def _merge_windows(windows: list[tuple[float, float]], *, pad: float, duration: float) -> list[tuple[float, float]]:
    if not windows:
        return []
    cleaned = []
    for a, b in windows:
        a = max(0.0, a - pad)
        b = min(duration, b + pad)
        if b - a >= 0.05:
            cleaned.append((a, b))
    cleaned.sort()
    merged: list[tuple[float, float]] = [cleaned[0]]
    for a, b in cleaned[1:]:
        pa, pb = merged[-1]
        if a <= pb + 0.15:
            merged[-1] = (pa, max(pb, b))
        else:
            merged.append((a, b))
    return merged


def apply_overlays(
    source: Path,
    dest: Path,
    overlays: list[dict[str, Any]],
    *,
    clip_duration: float | None = None,
    on_progress: ProgressCb | None = None,
) -> Path:
    """Burn visual/timeline effects into a cut file via filtergraph."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    if not overlays:
        if source.resolve() != dest.resolve():
            shutil.copy2(source, dest)
        return dest

    dur = clip_duration
    if dur is None:
        try:
            dur = probe_duration(source)
        except FFmpegError:
            dur = None

    expected_out: float | None = None
    if dur and dur > 0.5:
        expected_out = overlay_output_duration(float(dur), overlays)

    # Color/speed/etc. really do touch every frame. Fade does not — even when
    # the timeline bar spans the whole cut, only head/tail pixels change.
    if dur and not _needs_full_reencode(overlays):
        windows = _overlay_reencode_windows(overlays, float(dur))
        merged = _merge_windows(windows, pad=0.35, duration=float(dur))
        covered = sum(b - a for a, b in merged)
        if merged and covered / float(dur) <= 0.72:
            try:
                out = _apply_overlays_localized(
                    source,
                    dest,
                    overlays,
                    duration=float(dur),
                    windows=merged,
                    on_progress=on_progress,
                )
                if expected_out is not None:
                    return ensure_clip_duration(out, expected_out, label="efekt")
                return out
            except FFmpegError:
                if dest.exists():
                    try:
                        dest.unlink()
                    except OSError:
                        pass
                # Do not encode the untouched middle just because concat failed.
                if covered / float(dur) <= 0.55:
                    raise

    _encode_overlays(
        source,
        dest,
        overlays,
        clip_duration=dur,
        time_offset=0.0,
        on_progress=on_progress,
    )
    if expected_out is not None:
        return ensure_clip_duration(dest, expected_out, label="efekt")
    return dest


def _apply_overlays_localized(
    source: Path,
    dest: Path,
    overlays: list[dict[str, Any]],
    *,
    duration: float,
    windows: list[tuple[float, float]] | None = None,
    on_progress: ProgressCb | None = None,
) -> Path:
    """Re-encode only overlay/fade windows; stream-copy the rest (huge win on long cuts)."""
    if windows is None:
        windows = _merge_windows(
            _overlay_reencode_windows(overlays, duration), pad=0.35, duration=duration
        )
    merged = _snap_windows_to_keyframes(source, windows, duration) or windows
    covered = sum(b - a for a, b in merged)
    if not merged or covered / duration > 0.72:
        raise FFmpegError("localized skip")

    fps = probe_fps(source)
    work = Path(tempfile.mkdtemp(prefix="cutmuck-fx-"))
    parts: list[Path] = []
    cursor = 0.0
    part_i = 0
    encode_span = max(0.01, covered)

    def _copy_span(a: float, b: float) -> None:
        nonlocal part_i
        if b - a < 0.05:
            return
        out = work / f"p{part_i:03d}.mp4"
        part_i += 1
        cmd = [
            _ffmpeg(),
            "-y",
            "-ss",
            f"{a:.3f}",
            "-i",
            str(source),
            "-t",
            f"{b - a:.3f}",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            str(out),
        ]
        run_ffmpeg(cmd)
        parts.append(out)

    encoded_done = 0.0
    try:
        for a, b in merged:
            if a > cursor + 0.05:
                _copy_span(cursor, a)
            out = work / f"p{part_i:03d}.mp4"
            part_i += 1
            slen = b - a

            def _cb(frac: float, start=encoded_done, span=slen) -> None:
                if on_progress:
                    on_progress(min(0.99, (start + frac * span) / encode_span))

            _encode_overlays(
                source,
                out,
                overlays,
                clip_duration=duration,
                time_offset=a,
                slice_len=slen,
                on_progress=_cb,
                compat_concat=True,
                fps=fps,
            )
            parts.append(out)
            encoded_done += slen
            cursor = b
        if duration - cursor > 0.05:
            _copy_span(cursor, duration)
        _concat_copy(parts, dest, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if not dest.exists() or dest.stat().st_size < 1024:
        raise FFmpegError("concat çıktısı boş")
    if on_progress:
        on_progress(1.0)
    return dest


def _encode_overlays(
    source: Path,
    dest: Path,
    overlays: list[dict[str, Any]],
    *,
    clip_duration: float | None,
    time_offset: float = 0.0,
    slice_len: float | None = None,
    on_progress: ProgressCb | None = None,
    compat_concat: bool = False,
    fps: float | None = None,
) -> None:
    speed = 1.0
    fade_in = 0.0
    fade_out = 0.0
    hold_in = 0.0
    hold_out = 0.0
    fade_color = "black"
    brightness = 0.0
    contrast = 1.0
    saturation = 1.0
    vignette = False
    blur = 0.0
    sharpen = 0.0
    noise = 0.0
    grayscale = False
    sepia = False
    mirror = False
    letterbox = 0.0
    tint_color = ""
    tint_amount = 0.0
    visuals: list[dict[str, Any]] = []

    for ov in overlays:
        if ov.get("hidden"):
            continue
        kind = ov.get("type") or "text"
        if kind == "speed":
            try:
                speed = float(ov.get("speed") or 1.0)
            except (TypeError, ValueError):
                speed = 1.0
            speed = max(0.5, min(2.0, speed))
        elif kind in {"fade", "fadeblack"}:
            fade_in = max(0.0, float(ov.get("fade_in") or (1.5 if kind == "fadeblack" else 0)))
            fade_out = max(0.0, float(ov.get("fade_out") or (1.5 if kind == "fadeblack" else 0)))
            if "hold_in" in ov and ov.get("hold_in") is not None:
                hold_in = max(0.0, float(ov.get("hold_in") or 0))
            else:
                hold_in = 2.0 if kind == "fadeblack" else 0.0
            if "hold_out" in ov and ov.get("hold_out") is not None:
                hold_out = max(0.0, float(ov.get("hold_out") or 0))
            else:
                hold_out = 2.0 if kind == "fadeblack" else 0.0
            raw_c = str(ov.get("color") or "black").lstrip("#").lower()
            fade_color = "white" if raw_c in {"ffffff", "fff", "white"} else "black"
        elif kind == "brightness":
            brightness = float(ov.get("brightness") or 0)
            if ov.get("contrast") is not None:
                contrast = float(ov.get("contrast") or 1)
        elif kind == "contrast":
            contrast = float(ov.get("contrast") or 1)
        elif kind == "saturate":
            saturation = float(ov.get("saturation") or ov.get("amount") or 1)
        elif kind == "vignette":
            vignette = True
        elif kind == "blur":
            blur = max(0.0, float(ov.get("blur") or ov.get("amount") or 0))
        elif kind == "sharpen":
            sharpen = max(0.0, float(ov.get("amount") or 0.5))
        elif kind == "noise":
            noise = max(0.0, min(100.0, float(ov.get("amount") or 10)))
        elif kind == "grayscale":
            grayscale = True
        elif kind == "sepia":
            sepia = True
        elif kind == "mirror":
            mirror = True
        elif kind == "letterbox":
            letterbox = max(0.02, min(0.35, float(ov.get("amount") or ov.get("h") or 0.12)))
        elif kind == "tint":
            tint_color = str(ov.get("color") or "#ffaa66")
            tint_amount = max(0.0, min(1.0, float(ov.get("amount") or ov.get("opacity") or 0.25)))
        elif kind in {"text", "rect"}:
            visuals.append(ov)

    vf: list[str] = []
    af: list[str] = []
    off = time_offset

    if mirror:
        vf.append("hflip")

    if abs(speed - 1.0) > 0.01:
        vf.append(f"setpts=PTS/{speed}")
        af.append(f"atempo={speed:.3f}")

    if abs(brightness) > 0.01 or abs(contrast - 1.0) > 0.01 or abs(saturation - 1.0) > 0.01:
        vf.append(
            f"eq=brightness={brightness:.3f}:contrast={contrast:.3f}:saturation={saturation:.3f}"
        )

    if grayscale:
        vf.append("hue=s=0")
    if sepia:
        vf.append("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131")
    if blur > 0.05:
        vf.append(f"gblur=sigma={min(20.0, blur):.2f}")
    if sharpen > 0.05:
        luma = 0.5 + sharpen * 1.5
        vf.append(f"unsharp=5:5:{luma:.2f}:5:5:0.0")
    if noise > 0.5:
        vf.append(f"noise=alls={noise:.1f}:allf=t")
    if vignette:
        vf.append("vignette=PI/4")
    if tint_amount > 0.02 and tint_color:
        hexcol = tint_color.lstrip("#")
        if len(hexcol) >= 6:
            try:
                r = int(hexcol[0:2], 16) / 255.0
                g = int(hexcol[2:4], 16) / 255.0
                b = int(hexcol[4:6], 16) / 255.0
                a = tint_amount
                vf.append(
                    f"colorbalance=rs={(r - 0.5) * a:.3f}:gs={(g - 0.5) * a:.3f}:bs={(b - 0.5) * a:.3f}"
                )
            except ValueError:
                pass

    dur = clip_duration
    slice_duration = slice_len if slice_len is not None else dur

    if hold_in > 0 or fade_in > 0:
        if hold_in > 0 and off <= hold_in:
            local_hold = hold_in - off
            vf.append(
                f"drawbox=x=0:y=0:w=iw:h=ih:color={fade_color}@1:t=fill:"
                f"enable='lte(t\\,{local_hold:.3f})'"
            )
        if fade_in > 0 and off < hold_in + fade_in:
            st = max(0.0, hold_in - off)
            vf.append(f"fade=t=in:st={st:.3f}:d={fade_in:.3f}:color={fade_color}")

    if dur and (hold_out > 0 or fade_out > 0) and slice_duration:
        out_fade_start = max(0.0, float(dur) - hold_out - fade_out)
        if fade_out > 0 and off + (slice_duration or 0) >= out_fade_start:
            st = max(0.0, out_fade_start - off)
            vf.append(f"fade=t=out:st={st:.3f}:d={fade_out:.3f}:color={fade_color}")
        if hold_out > 0:
            hold_start = max(0.0, float(dur) - hold_out)
            if off + (slice_duration or 0) >= hold_start:
                st = max(0.0, hold_start - off)
                vf.append(
                    f"drawbox=x=0:y=0:w=iw:h=ih:color={fade_color}@1:t=fill:"
                    f"enable='gte(t\\,{st:.3f})'"
                )

    if letterbox > 0:
        vf.append(
            f"drawbox=x=0:y=0:w=iw:h=ih*{letterbox:.4f}:color=black@1:t=fill,"
            f"drawbox=x=0:y=ih*(1-{letterbox:.4f}):w=iw:h=ih*{letterbox:.4f}:color=black@1:t=fill"
        )

    for ov in visuals:
        kind = ov.get("type") or "text"
        x = float(ov.get("x") or 0.5)
        y = float(ov.get("y") or 0.5)
        w = float(ov.get("w") or 0.28)
        h = float(ov.get("h") or 0.12)
        start = float(ov.get("start_sec") or 0) - off
        end = ov.get("end_sec")
        end_l = (float(end) - off) if end is not None else None
        enable = f"gte(t\\,{start:.3f})"
        if end_l is not None:
            enable = f"between(t\\,{start:.3f}\\,{end_l:.3f})"
        color = _ffmpeg_color(str(ov.get("color") or "white"), default_alpha=1.0)
        if kind == "rect":
            opacity = float(ov.get("opacity") or 0.45)
            fill = _ffmpeg_color(str(ov.get("color") or "white"), default_alpha=opacity)
            vf.append(
                f"drawbox=x=w*{max(0.0, x - w / 2):.4f}:y=h*{max(0.0, y - h / 2):.4f}:"
                f"w=w*{w:.4f}:h=h*{h:.4f}:color={fill}:"
                f"t=fill:enable='{enable}'"
            )
        else:
            raw = _escape_drawtext(str(ov.get("text") or "")[:120])
            size = int(ov.get("font_size") or 42)
            box = ""
            bg = str(ov.get("bg") or "").strip()
            if bg:
                box_color = _ffmpeg_color(bg, default_alpha=0.55)
                box = f":box=1:boxcolor={box_color}:boxborderw=12"
            vf.append(
                f"drawtext=text='{raw}':fontsize={size}:fontcolor={color}{box}:"
                f"x=(w-text_w)*{x:.3f}:y=(h-text_h)*{y:.3f}:enable='{enable}'"
            )

    input_args: list[str] = ["-y"]
    if time_offset > 0.02:
        input_args.extend(["-ss", f"{time_offset:.3f}"])
    input_args.extend(["-i", str(source)])
    if slice_len is not None:
        input_args.extend(["-t", f"{slice_len:.3f}"])

    last_err = ""
    encoders = [_compat_x264()] if compat_concat else _encoder_candidates()
    for enc in encoders:
        cmd = [_ffmpeg(), *input_args]
        if fps and fps > 1:
            cmd.extend(["-r", f"{fps:.5f}".rstrip("0").rstrip(".")])
        if vf:
            cmd.extend(["-vf", ",".join(vf)])
        if af:
            cmd.extend(["-af", ",".join(af)])
        else:
            cmd.extend(["-c:a", "copy"])
        cmd.extend(["-c:v", *enc, "-movflags", "+faststart", str(dest)])
        try:
            run_ffmpeg(cmd, duration=slice_len or clip_duration, on_progress=on_progress)
            if dest.exists() and dest.stat().st_size > 1024:
                return
        except FFmpegError as exc:
            last_err = str(exc)
            if dest.exists():
                try:
                    dest.unlink()
                except OSError:
                    pass
            continue
    raise FFmpegError(last_err or "Efekt uygulaması başarısız")


def trim_keep_last(source: Path, dest: Path, keep_sec: float) -> Path:
    """Keep only the last keep_sec seconds of source."""
    dur = probe_duration(source)
    if dur <= keep_sec + 0.5:
        if source.resolve() != dest.resolve():
            shutil.copy2(source, dest)
        return dest
    start = max(0.0, dur - keep_sec)
    return cut_media(source, dest, start, dur)
