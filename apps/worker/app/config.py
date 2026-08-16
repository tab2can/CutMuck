from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_root() -> Path:
    # apps/worker/app/config.py -> repo root
    return Path(__file__).resolve().parents[3]


ROOT = Path(os.environ.get("CUTMUCK_ROOT", str(_default_root())))
DATA_DIR = Path(os.environ.get("CUTMUCK_DATA", str(ROOT / "data")))
MEDIA_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "cutmuck.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8787
    public_base_url: str = "http://127.0.0.1:8787"
    web_origin: str = "http://localhost:3000"
    data_dir: Path = DATA_DIR
    media_dir: Path = MEDIA_DIR
    db_path: Path = DB_PATH


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.media_dir.mkdir(parents=True, exist_ok=True)
