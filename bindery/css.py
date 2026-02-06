from __future__ import annotations

from typing import Optional

MAX_CSS_LENGTH = 200_000


def validate_css(raw: str) -> Optional[str]:
    if not raw or not raw.strip():
        return None

    if len(raw) > MAX_CSS_LENGTH:
        return f"CSS 过长（超过 {MAX_CSS_LENGTH} 字符）"
    if "\x00" in raw:
        return "CSS 包含非法字符"

    depth = 0
    in_string: Optional[str] = None
    escape = False
    i = 0
    while i < len(raw):
        ch = raw[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_string:
                in_string = None
            i += 1
            continue

        if ch in ("'", '"'):
            in_string = ch
            i += 1
            continue

        if ch == "/" and i + 1 < len(raw) and raw[i + 1] == "*":
            end = raw.find("*/", i + 2)
            if end == -1:
                return "CSS 注释未闭合"
            i = end + 2
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                return "CSS 花括号不匹配"

        i += 1

    if in_string:
        return "CSS 字符串未闭合"
    if depth != 0:
        return "CSS 花括号不匹配"
    return None
