from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

import httpx

from .session_auth import new_oauth_state

AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
USERINFO_URI = "https://www.googleapis.com/oauth2/v3/userinfo"
LOGIN_SCOPES = ["openid", "email", "profile"]


class LoginAuthError(Exception):
    pass


def build_login_auth_url(*, client_id: str, redirect_uri: str, state: str) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(LOGIN_SCOPES),
        "access_type": "online",
        "prompt": "select_account",
        "include_granted_scopes": "false",
        "state": state,
    }
    return f"{AUTH_URI}?{urlencode(params)}"


def exchange_login_code(
    *,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    code: str,
) -> dict[str, Any]:
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            TOKEN_URI,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
        )
    data = resp.json() if resp.content else {}
    if resp.status_code >= 400:
        detail = data.get("error_description") or data.get("error") or resp.text
        raise LoginAuthError(f"Google token alınamadı: {detail}")
    access = data.get("access_token")
    if not access:
        raise LoginAuthError("Access token yok")
    return data


def fetch_google_user(access_token: str) -> dict[str, Any]:
    with httpx.Client(timeout=30.0) as client:
        resp = client.get(
            USERINFO_URI,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    data = resp.json() if resp.content else {}
    if resp.status_code >= 400:
        detail = data.get("error_description") or data.get("error") or resp.text
        raise LoginAuthError(f"Google profil alınamadı: {detail}")
    email = (data.get("email") or "").strip().lower()
    if not email:
        raise LoginAuthError("Google hesabında e-posta yok")
    if data.get("email_verified") is False:
        raise LoginAuthError("Google e-postası doğrulanmamış")
    return {
        "email": email,
        "name": str(data.get("name") or ""),
        "picture": str(data.get("picture") or ""),
    }


# re-export for callers that already import from here
__all__ = [
    "LoginAuthError",
    "build_login_auth_url",
    "exchange_login_code",
    "fetch_google_user",
    "new_oauth_state",
]
