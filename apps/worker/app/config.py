from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_root() -> Path:
    """Repo root locally; worker package root (/app) in Docker."""
    # .../apps/worker/app/config.py  →  repo
    # /app/app/config.py (Docker)     →  /app
    here = Path(__file__).resolve().parent  # .../app
    worker_dir = here.parent  # .../worker or /app
    if worker_dir.name == "worker" and worker_dir.parent.name == "apps":
        return worker_dir.parent.parent
    return worker_dir


def _cpu_count() -> int:
    n = os.cpu_count() or 2
    return max(1, int(n))


ROOT = Path(os.environ["CUTMUCK_ROOT"]) if "CUTMUCK_ROOT" in os.environ else _default_root()
DATA_DIR = Path(os.environ.get("CUTMUCK_DATA", str(ROOT / "data")))
MEDIA_DIR = DATA_DIR / "media"
ASSETS_DIR = DATA_DIR / "channel_assets"
DB_PATH = DATA_DIR / "cutmuck.db"

_CPUS = _cpu_count()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8787
    public_base_url: str = "http://127.0.0.1:8787"
    web_origin: str = "http://localhost:3000"
    data_dir: Path = DATA_DIR
    media_dir: Path = MEDIA_DIR
    assets_dir: Path = ASSETS_DIR
    db_path: Path = DB_PATH

    # App login (Google Sign-In) — required in production
    admin_email: str = "can@pekgezer.com"
    google_client_id: str = ""
    google_client_secret: str = ""
    session_secret: str = ""

    # Performance (auto-tuned for dedicated box; override via env)
    # 6c/12GB defaults: leave 1 core for OS/uvicorn, serialize heavy jobs
    ffmpeg_threads: int = max(1, _CPUS - 1)
    hls_download_workers: int = min(8, max(3, _CPUS))
    heavy_job_slots: int = 1


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.media_dir.mkdir(parents=True, exist_ok=True)
settings.assets_dir.mkdir(parents=True, exist_ok=True)
settings.admin_email = settings.admin_email.strip().lower()
settings.ffmpeg_threads = max(1, int(settings.ffmpeg_threads))
settings.hls_download_workers = max(1, min(16, int(settings.hls_download_workers)))
settings.heavy_job_slots = max(1, min(4, int(settings.heavy_job_slots)))
