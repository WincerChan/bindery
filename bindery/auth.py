from __future__ import annotations

import datetime as dt
import secrets
from typing import Optional

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerificationError, VerifyMismatchError

from .db import create_session, delete_session, get_session, touch_session
from .env import read_env

SESSION_COOKIE = "bindery_session"


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def configured_hash() -> Optional[str]:
    return read_env("BINDERY_PASSWORD_HASH")


def verify_password(password: str) -> bool:
    stored = configured_hash()
    if not stored:
        return False
    hasher = PasswordHasher()
    try:
        return hasher.verify(stored, password)
    except (VerifyMismatchError, InvalidHash, VerificationError):
        return False


def create_session_token() -> str:
    return secrets.token_urlsafe(32)


def sign_in() -> str:
    session_id = create_session_token()
    now = _now_iso()
    create_session(session_id, now)
    return session_id


def is_authenticated(session_id: Optional[str]) -> bool:
    if not session_id:
        return False
    session = get_session(session_id)
    if not session:
        return False
    touch_session(session_id, _now_iso())
    return True


def sign_out(session_id: Optional[str]) -> None:
    if not session_id:
        return
    delete_session(session_id)
