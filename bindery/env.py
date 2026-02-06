from __future__ import annotations

import os
from pathlib import Path
from typing import Optional


def read_env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name)
    if value not in {None, ""}:
        return value

    file_var = os.getenv(f"{name}_FILE")
    if not file_var:
        return default

    try:
        content = Path(file_var).read_text(encoding="utf-8")
    except OSError:
        return default
    return content.rstrip("\r\n")
