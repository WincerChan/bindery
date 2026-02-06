from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class ThemeTemplate:
    theme_id: str
    name: str
    description: Optional[str]
    version: str
    file_path: Path
    css: str


def themes_dir() -> Path:
    env = os.getenv("BINDERY_THEMES_DIR")
    path = Path(env) if env else BASE_DIR / "themes"
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_default_themes() -> None:
    path = themes_dir()
    default_file = path / "default.json"
    if default_file.exists():
        return
    bundled = BASE_DIR / "themes" / "default.json"
    if bundled.exists():
        shutil.copyfile(bundled, default_file)
        return
    data = {
        "id": "default",
        "name": "默认样式",
        "description": "生成 EPUB 的默认排版（可全局复用）",
        "version": "1",
        "css": "",
    }
    default_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_theme_templates() -> list[ThemeTemplate]:
    ensure_default_themes()
    templates: list[ThemeTemplate] = []
    for file_path in sorted(themes_dir().glob("*.json")):
        try:
            data = json.loads(file_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        theme_id = str(data.get("id") or file_path.stem)
        name = str(data.get("name") or theme_id)
        description = data.get("description")
        version = str(data.get("version") or "1")
        css = str(data.get("css") or "").rstrip()
        templates.append(
            ThemeTemplate(
                theme_id=theme_id,
                name=name,
                description=description,
                version=version,
                file_path=file_path,
                css=css,
            )
        )
    return templates


def get_theme(theme_id: str) -> ThemeTemplate:
    templates = load_theme_templates()
    for template in templates:
        if template.theme_id == theme_id:
            return template
    return templates[0]


def compose_css(theme_css: str | None, custom_css: str | None) -> str:
    parts: list[str] = []
    if theme_css and theme_css.strip():
        parts.append(theme_css.strip())
    if custom_css and custom_css.strip():
        parts.append(custom_css.strip())
    return "\n\n".join(parts).strip()
