from __future__ import annotations

import base64
import re
from pathlib import Path

from .config import settings

_SLUG_RE = re.compile(r"[^a-zA-Z0-9_-]+")
_OWNER_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_DATA_URL_RE = re.compile(r"^data:(image/(png|jpeg|jpg|webp|gif));base64,(.+)$", re.I | re.S)

MAX_ASSET_BYTES = 5 * 1024 * 1024
MAX_ASSETS_PER_CHANNEL = 40


def safe_slug(slug: str | None) -> str:
    raw = _SLUG_RE.sub("", (slug or "").strip().lower())[:80]
    return raw or "_genel"


def safe_owner(email: str) -> str:
    return _OWNER_RE.sub("_", email.strip().lower())[:80]


def asset_path(owner_email: str, slug: str, asset_id: str) -> Path:
    folder = settings.assets_dir / safe_owner(owner_email) / safe_slug(slug)
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{asset_id}.bin"


def parse_image_data_url(data_url: str) -> tuple[str, bytes]:
    text = (data_url or "").strip()
    match = _DATA_URL_RE.match(text)
    if not match:
        raise ValueError("Geçerli bir görsel (PNG/JPEG/WebP) gerekli")
    mime = match.group(1).lower()
    if mime == "image/jpg":
        mime = "image/jpeg"
    try:
        raw = base64.b64decode(match.group(3), validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Görsel okunamadı") from exc
    if not raw:
        raise ValueError("Boş görsel")
    if len(raw) > MAX_ASSET_BYTES:
        raise ValueError("Görsel 5 MB sınırını aşıyor")
    return mime, raw
