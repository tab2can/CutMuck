from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field


Privacy = Literal["public", "unlisted", "private"]


def parse_kick_slug(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("Kanal adı veya URL gerekli")
    if "://" in value or value.startswith("kick.com") or value.startswith("www.kick.com"):
        if not value.startswith("http"):
            value = "https://" + value
        path = urlparse(value).path.strip("/")
        parts = [p for p in path.split("/") if p]
        if not parts:
            raise ValueError("Geçersiz Kick URL")
        return parts[0].lower()
    slug = re.sub(r"[^a-zA-Z0-9_-]", "", value)
    if not slug:
        raise ValueError("Geçersiz Kick kullanıcı adı")
    return slug.lower()


class ChannelCreate(BaseModel):
    input: str = Field(..., description="Kick username or URL")


class SettingsUpdate(BaseModel):
    theme: str | None = None
    youtube_client_id: str | None = None
    youtube_client_secret: str | None = None
    youtube_privacy_default: Privacy | None = None
    worker_public_url: str | None = None


class AllowedEmailCreate(BaseModel):
    email: str
    role: Literal["admin", "user"] = "user"


class DownloadRequest(BaseModel):
    vod_url: str = ""
    channel_slug: str | None = None
    title: str | None = None
    thumbnail: str | None = None
    duration: float | None = None
    kind: Literal["vod", "clip", "live"] = "vod"
    clip_id: str | None = None


class LiveOpenRequest(BaseModel):
    channel_slug: str
    title: str | None = None


class CutRequest(BaseModel):
    start_sec: float = 0
    end_sec: float


class TimelineOverlay(BaseModel):
    id: str
    type: Literal[
        "text",
        "rect",
        "fade",
        "fadeblack",
        "speed",
        "brightness",
        "contrast",
        "vignette",
        "blur",
        "saturate",
        "grayscale",
        "sepia",
        "sharpen",
        "noise",
        "letterbox",
        "mirror",
        "tint",
    ] = "text"
    text: str = ""
    start_sec: float = 0
    end_sec: float | None = None
    x: float = 0.5
    y: float = 0.5
    w: float = 0.28
    h: float = 0.12
    font_size: int = 42
    color: str = "white"
    bg: str = ""
    opacity: float = 1.0
    fade_in: float = 0
    fade_out: float = 0
    hold_in: float = 0
    hold_out: float = 0
    speed: float = 1.0
    brightness: float = 0.0
    contrast: float = 1.0
    saturation: float = 1.0
    blur: float = 0.0
    amount: float = 0.5
    rotation: float = 0.0
    hidden: bool = False
    locked: bool = False


class TimelineUpdate(BaseModel):
    overlays: list[TimelineOverlay] = Field(default_factory=list)


class ChannelAssetCreate(BaseModel):
    name: str = "görsel"
    data_url: str


class YoutubeUploadRequest(BaseModel):
    title: str
    description: str = ""
    privacy: Privacy = "unlisted"
    start_sec: float | None = None
    end_sec: float | None = None
    thumbnail_data_url: str | None = None
    overlays: list[TimelineOverlay] | None = None


class JobOut(BaseModel):
    id: str
    kind: str
    status: str
    progress: float
    channel_slug: str | None = None
    source_url: str | None = None
    title: str | None = None
    local_path: str | None = None
    cut_path: str | None = None
    error: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)
    media_url: str | None = None
    cut_url: str | None = None
    stream_url: str | None = None
    cut_size_bytes: int | None = None
    updated_at: str | None = None
