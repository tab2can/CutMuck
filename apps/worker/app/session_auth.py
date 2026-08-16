from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Literal

from .config import settings

COOKIE_NAME = "cutmuck_session"
SESSION_TTL_SEC = 60 * 60 * 24 * 30  # 30 days
Role = Literal["admin", "user"]


@dataclass(frozen=True)
class SessionUser:
    email: str
    role: Role
    name: str = ""
    picture: str = ""


def _secret_bytes() -> bytes:
    raw = (settings.session_secret or "").encode("utf-8")
    if len(raw) < 16:
        # Deterministic fallback only for local misconfig — still better than crash
        raw = hashlib.sha256(b"cutmuck-dev|" + settings.admin_email.encode()).digest()
    return raw


def normalize_email(email: str) -> str:
    return email.strip().lower()


def sign_session(user: SessionUser) -> str:
    payload = {
        "email": normalize_email(user.email),
        "role": user.role,
        "name": user.name or "",
        "picture": user.picture or "",
        "exp": int(time.time()) + SESSION_TTL_SEC,
    }
    body = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    sig = hmac.new(_secret_bytes(), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify_session(token: str | None) -> SessionUser | None:
    if not token or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    expected = hmac.new(_secret_bytes(), body.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        raw = base64.urlsafe_b64decode(body.encode("ascii"))
        data: dict[str, Any] = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    exp = int(data.get("exp") or 0)
    if exp < int(time.time()):
        return None
    email = normalize_email(str(data.get("email") or ""))
    role = data.get("role")
    if not email or role not in {"admin", "user"}:
        return None
    return SessionUser(
        email=email,
        role=role,  # type: ignore[arg-type]
        name=str(data.get("name") or ""),
        picture=str(data.get("picture") or ""),
    )


def new_oauth_state() -> str:
    return secrets.token_urlsafe(24)


def cookie_secure() -> bool:
    return settings.web_origin.rstrip("/").startswith("https://")


def session_cookie_kwargs(value: str, *, clear: bool = False) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "key": COOKIE_NAME,
        "value": "" if clear else value,
        "httponly": True,
        "samesite": "lax",
        "secure": cookie_secure(),
        "path": "/",
    }
    if clear:
        kwargs["max_age"] = 0
    else:
        kwargs["max_age"] = SESSION_TTL_SEC
    return kwargs
