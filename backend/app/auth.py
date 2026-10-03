"""Session-cookie auth with a simple sliding-window rate limiter."""
from __future__ import annotations

import time
from collections import defaultdict

from fastapi import Depends, HTTPException, Request, Response, status

from .config import config_store

COOKIE = "netdash_session"
MAX_ATTEMPTS = 8
WINDOW_SECONDS = 300

_attempts: dict[str, list[float]] = defaultdict(list)


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def check_rate_limit(request: Request) -> None:
    key = _client_key(request)
    now = time.time()
    hits = [t for t in _attempts[key] if now - t < WINDOW_SECONDS]
    if len(hits) >= MAX_ATTEMPTS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Terlalu banyak percobaan login. Coba lagi dalam beberapa menit.",
        )
    _attempts[key] = hits


def record_failure(request: Request) -> None:
    _attempts[_client_key(request)].append(time.time())


def clear_failures(request: Request) -> None:
    _attempts.pop(_client_key(request), None)


def issue_session(response: Response, username: str) -> None:
    from itsdangerous import URLSafeTimedSerializer

    s = URLSafeTimedSerializer(config_store.settings.session_secret, salt="netdash")
    token = s.dumps({"u": username})
    response.set_cookie(
        COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=7 * 24 * 3600,
        path="/",
    )


def clear_session(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/")


def current_username(request: Request) -> str:
    from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Login required")
    s = URLSafeTimedSerializer(config_store.settings.session_secret, salt="netdash")
    try:
        data = s.loads(token, max_age=7 * 24 * 3600)
    except (BadSignature, SignatureExpired):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesi kedaluwarsa")
    return data.get("u", "")


def require_auth(request: Request) -> str:
    return current_username(request)
