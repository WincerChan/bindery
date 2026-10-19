from __future__ import annotations

import datetime as dt
import ipaddress
import re
import secrets
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerificationError, VerifyMismatchError
from starlette.requests import Request

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


def sign_in(auth_method: str = "password", password_verified_at: Optional[str] = None) -> str:
    session_id = create_session_token()
    now = _now_iso()
    if auth_method == "password" and password_verified_at is None:
        password_verified_at = now
    create_session(session_id, now, auth_method, password_verified_at)
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


@dataclass(frozen=True)
class WebAuthnConfig:
    origin: str
    rp_id: str

    @property
    def secure(self) -> bool:
        return self.origin.startswith("https://")


def webauthn_config(request: Optional[Request] = None) -> Optional[WebAuthnConfig]:
    """Resolve the explicit public origin, with a localhost-only development fallback."""
    origin = read_env("BINDERY_PUBLIC_ORIGIN")
    if not origin:
        if request is not None and request.url.hostname == "localhost":
            return WebAuthnConfig(f"{request.url.scheme}://{request.url.netloc}", "localhost")
        return None
    try:
        if any(ord(char) <= 32 or ord(char) == 127 for char in origin) or "\\" in origin:
            return None
        parsed = urlsplit(origin)
        host = parsed.hostname
        if (not host or parsed.scheme not in {"http", "https"} or parsed.path
                or parsed.query or parsed.fragment or parsed.username is not None
                or parsed.password is not None or origin.endswith(("/", "?", "#"))):
            return None
        # Accessing .port also rejects invalid ports.
        port = parsed.port
        host = host.encode("idna").decode("ascii")
        if parsed.scheme != "https" and host != "localhost":
            return None
        if not _dns_hostname(host):
            return None
        rp_id = (read_env("BINDERY_WEBAUTHN_RP_ID") or host).encode("idna").decode("ascii").lower()
        if not _dns_hostname(rp_id):
            return None
        if rp_id != host and ("." not in rp_id or not host.endswith("." + rp_id)):
            return None
        origin = f"{parsed.scheme}://{host}"
        if port is not None and port != {"http": 80, "https": 443}[parsed.scheme]:
            origin += f":{port}"
        return WebAuthnConfig(origin, rp_id)
    except ValueError:
        return None


def _dns_hostname(value: str) -> bool:
    # Browsers also interpret decimal and hexadecimal IPv4 spellings as IP addresses.
    if re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]+)", value.rsplit(".", 1)[-1]):
        return False
    try:
        ipaddress.ip_address(value)
        return False
    except ValueError:
        return len(value) <= 253 and all(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in value.split(".")
        )


def password_is_fresh(session: Optional[dict]) -> bool:
    if not session or not session.get("password_verified_at"):
        return False
    try:
        verified = dt.datetime.fromisoformat(session["password_verified_at"])
        age = dt.datetime.now(dt.timezone.utc) - verified
        return dt.timedelta(0) <= age <= dt.timedelta(minutes=10)
    except (ValueError, TypeError):
        return False
