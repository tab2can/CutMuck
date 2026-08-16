from __future__ import annotations

import asyncio
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import settings
from .ffmpeg_util import FFmpegError, probe_duration, trim_keep_last
from .stream import _which


RING_SECONDS = 10 * 60  # keep last 10 minutes


@dataclass
class _RingState:
    job_id: str
    page_url: str
    process: subprocess.Popen[Any] | None = None
    raw_path: Path = field(default_factory=Path)
    window_path: Path = field(default_factory=Path)
    task: asyncio.Task[None] | None = None
    stopped: bool = False


_rings: dict[str, _RingState] = {}


def ring_window_path(job_id: str) -> Path:
    return settings.media_dir / f"{job_id}_ring_window.mp4"


def ring_raw_path(job_id: str) -> Path:
    return settings.media_dir / f"{job_id}_ring_raw.ts"


async def start_live_ring(job_id: str, page_url: str) -> None:
    """Start continuous live capture; maintain a rolling last-N-minutes window."""
    await stop_live_ring(job_id)
    streamlink = _which("streamlink")
    if not streamlink:
        return

    raw = ring_raw_path(job_id)
    window = ring_window_path(job_id)
    if raw.exists():
        raw.unlink()
    settings.media_dir.mkdir(parents=True, exist_ok=True)

    proc = subprocess.Popen(
        [
            streamlink,
            "--force",
            "--retry-streams",
            "10",
            "--retry-max",
            "0",
            "--stream-timeout",
            "60",
            "--hls-live-edge",
            "3",
            "-o",
            str(raw),
            page_url,
            "best",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    state = _RingState(
        job_id=job_id,
        page_url=page_url,
        process=proc,
        raw_path=raw,
        window_path=window,
    )
    _rings[job_id] = state
    state.task = asyncio.create_task(_maintain_ring(state))


async def _maintain_ring(state: _RingState) -> None:
    while not state.stopped:
        await asyncio.sleep(20)
        if state.stopped:
            break
        if state.process and state.process.poll() is not None:
            # exited — try restart once
            if state.stopped:
                break
            streamlink = _which("streamlink")
            if not streamlink:
                break
            state.process = subprocess.Popen(
                [
                    streamlink,
                    "--force",
                    "--retry-streams",
                    "10",
                    "--retry-max",
                    "0",
                    "--stream-timeout",
                    "60",
                    "--hls-live-edge",
                    "3",
                    "-o",
                    str(state.raw_path),
                    state.page_url,
                    "best",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            continue
        if not state.raw_path.exists() or state.raw_path.stat().st_size < 50_000:
            continue
        tmp = state.window_path.with_suffix(".tmp.mp4")
        try:
            await asyncio.to_thread(trim_keep_last, state.raw_path, tmp, float(RING_SECONDS))
            if tmp.exists():
                if state.window_path.exists():
                    state.window_path.unlink()
                tmp.replace(state.window_path)
        except (FFmpegError, OSError):
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass


async def stop_live_ring(job_id: str) -> None:
    state = _rings.pop(job_id, None)
    if not state:
        return
    state.stopped = True
    if state.task:
        state.task.cancel()
        try:
            await state.task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    if state.process and state.process.poll() is None:
        state.process.terminate()
        try:
            state.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            state.process.kill()


def ring_status(job_id: str) -> dict[str, Any]:
    state = _rings.get(job_id)
    window = ring_window_path(job_id)
    duration = 0.0
    if window.exists():
        try:
            duration = probe_duration(window)
        except FFmpegError:
            duration = 0.0
    return {
        "active": bool(state and not state.stopped),
        "window_path": str(window) if window.exists() else None,
        "duration": duration,
        "max_seconds": RING_SECONDS,
        "updated_at": time.time(),
    }
