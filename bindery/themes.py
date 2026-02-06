from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .env import read_env

BASE_DIR = Path(__file__).resolve().parent.parent
THEMES_DIR_ENV = "BINDERY_THEMES_DIR"
TEMPLATES_DIR_ENV = "BINDERY_TEMPLATE_DIR"
DEFAULT_RUNTIME_TEMPLATES_DIR = BASE_DIR / ".bindery-user-templates"
SEED_THEMES_DIR = BASE_DIR / "bindery-templates" / "themes"
DEFAULT_THEME_CSS = """body {
  line-height: 1.75;
}
p {
  text-indent: 2rem;
  margin: 0 0 0.8em;
}
.chapter-header {
  margin: 1.25em 0 1em;
}
.chapter-stamp {
  display: inline-block;
  margin: 0 0 0.45em;
  padding: 0.1em 0.5em;
  font-size: 0.72em;
  letter-spacing: 0.1em;
  border: 1px solid currentColor;
  border-radius: 999px;
  text-indent: 0;
}
.chapter-title {
  margin: 0;
  font-size: 1.42em;
  font-weight: 760;
  line-height: 1.28;
}
.front-matter p.author {
  text-align: center;
  text-indent: 0;
  margin: 0 0 1.5em;
}
.front-matter p.intro-label {
  text-indent: 0;
  font-weight: 700;
  margin: 1.2em 0 0.6em;
}
.volume p, .volume .chapter-title {
  text-indent: 0;
}
"""


@dataclass(frozen=True)
class ThemeTemplate:
    theme_id: str
    name: str
    description: Optional[str]
    version: str
    file_path: Path
    css: str


def themes_dir() -> Path:
    env = read_env(THEMES_DIR_ENV)
    if env:
        path = Path(env)
    else:
        path = _templates_parent_dir() / "themes"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _templates_parent_dir() -> Path:
    env = read_env(TEMPLATES_DIR_ENV)
    path = Path(env) if env else DEFAULT_RUNTIME_TEMPLATES_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_default_themes() -> None:
    path = themes_dir()
    default_file = path / "default.json"
    if default_file.exists():
        return
    seed_default = SEED_THEMES_DIR / "default.json"
    if seed_default.exists():
        shutil.copy2(seed_default, default_file)
        return
    data = {
        "id": "default",
        "name": "默认样式",
        "description": "生成 EPUB 的默认排版（可全局复用）",
        "version": "1",
        "css": DEFAULT_THEME_CSS,
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
