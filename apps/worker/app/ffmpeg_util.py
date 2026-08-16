from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


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
        return dest
    cmd_enc = [
        _ffmpeg(),
        "-y",
        "-ss",
        f"{start_sec:.3f}",
        "-i",
        str(source),
        "-t",
        f"{duration:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(dest),
    ]
    proc2 = subprocess.run(cmd_enc, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc2.returncode != 0 or not dest.exists():
        raise FFmpegError(proc2.stderr or proc.stderr or "Kesme başarısız")
    return dest


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


def apply_overlays(
    source: Path,
    dest: Path,
    overlays: list[dict[str, Any]],
    *,
    clip_duration: float | None = None,
) -> Path:
    """Burn visual/timeline effects into a cut file via filtergraph."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    if not overlays:
        if source.resolve() != dest.resolve():
            shutil.copy2(source, dest)
        return dest

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
    if dur is None:
        try:
            dur = probe_duration(source) / max(speed, 0.01)
        except FFmpegError:
            dur = None

    if hold_in > 0 or fade_in > 0:
        # Solid black hold, then soft fade-in (prevents first-frame flash)
        if hold_in > 0:
            vf.append(
                f"drawbox=x=0:y=0:w=iw:h=ih:color={fade_color}@1:t=fill:"
                f"enable='lte(t\\,{hold_in:.3f})'"
            )
        if fade_in > 0:
            vf.append(
                f"fade=t=in:st={hold_in:.3f}:d={fade_in:.3f}:color={fade_color}"
            )

    if dur and (hold_out > 0 or fade_out > 0):
        out_fade_start = max(0.0, float(dur) - hold_out - fade_out)
        if fade_out > 0:
            vf.append(
                f"fade=t=out:st={out_fade_start:.3f}:d={fade_out:.3f}:color={fade_color}"
            )
        if hold_out > 0:
            hold_start = max(0.0, float(dur) - hold_out)
            vf.append(
                f"drawbox=x=0:y=0:w=iw:h=ih:color={fade_color}@1:t=fill:"
                f"enable='gte(t\\,{hold_start:.3f})'"
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
        start = float(ov.get("start_sec") or 0)
        end = ov.get("end_sec")
        enable = f"gte(t\\,{start:.3f})"
        if end is not None:
            enable = f"between(t\\,{start:.3f}\\,{float(end):.3f})"
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
                # Prefer alpha from rgba()/hex; otherwise soft box at 0.55
                box_color = _ffmpeg_color(bg, default_alpha=0.55)
                box = f":box=1:boxcolor={box_color}:boxborderw=12"
            vf.append(
                f"drawtext=text='{raw}':fontsize={size}:fontcolor={color}{box}:"
                f"x=(w-text_w)*{x:.3f}:y=(h-text_h)*{y:.3f}:enable='{enable}'"
            )

    cmd = [_ffmpeg(), "-y", "-i", str(source)]
    if vf:
        cmd.extend(["-vf", ",".join(vf)])
    if af:
        cmd.extend(["-af", ",".join(af)])
    else:
        cmd.extend(["-c:a", "aac", "-b:a", "160k"])
    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "22",
            "-movflags",
            "+faststart",
            str(dest),
        ]
    )
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not dest.exists():
        raise FFmpegError(proc.stderr or "Efekt uygulaması başarısız")
    return dest


def trim_keep_last(source: Path, dest: Path, keep_sec: float) -> Path:
    """Keep only the last keep_sec seconds of source."""
    dur = probe_duration(source)
    if dur <= keep_sec + 0.5:
        if source.resolve() != dest.resolve():
            shutil.copy2(source, dest)
        return dest
    start = max(0.0, dur - keep_sec)
    return cut_media(source, dest, start, dur)
