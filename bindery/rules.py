from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .parsing import DEFAULT_RULE_CONFIG, RuleConfig, RuleSet, build_rules

BASE_DIR = Path(__file__).resolve().parent.parent
RULES_DIR_ENV = "BINDERY_RULES_DIR"
TEMPLATES_DIR_ENV = "BINDERY_TEMPLATE_DIR"
DEFAULT_RUNTIME_TEMPLATES_DIR = BASE_DIR / ".bindery-user-templates"
SEED_RULES_DIR = BASE_DIR / "bindery-templates" / "rules"


@dataclass(frozen=True)
class RuleTemplate:
    rule_id: str
    name: str
    description: Optional[str]
    version: str
    file_path: Path
    rules: RuleSet


RULE_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


class RuleTemplateError(ValueError):
    pass


def validate_rule_id(rule_id: str) -> None:
    if not RULE_ID_RE.match(rule_id):
        raise RuleTemplateError("模板 ID 不合法：仅支持字母/数字/-/_，且需以字母或数字开头")


def validate_rule_template_json(rule_id: str, raw_json: str) -> dict:
    validate_rule_id(rule_id)
    try:
        data = json.loads(raw_json or "")
    except json.JSONDecodeError as exc:
        raise RuleTemplateError(f"JSON 解析失败：{exc}") from exc
    if not isinstance(data, dict):
        raise RuleTemplateError("JSON 顶层必须是对象 (object)")

    if "id" in data and str(data.get("id") or "").strip() and str(data.get("id")).strip() != rule_id:
        raise RuleTemplateError("JSON 内的 id 必须与当前模板 ID 一致（暂不支持重命名）")

    name = str(data.get("name") or rule_id).strip() or rule_id
    version = str(data.get("version") or "1").strip() or "1"
    description = data.get("description")
    if description is not None:
        description = str(description)

    chapter_patterns = data.get("chapter_patterns")
    if chapter_patterns is None:
        chapter_patterns = list(DEFAULT_RULE_CONFIG.chapter_patterns)
    if not isinstance(chapter_patterns, list) or not all(isinstance(p, str) for p in chapter_patterns):
        raise RuleTemplateError("chapter_patterns 必须是字符串数组")

    volume_patterns = data.get("volume_patterns")
    if volume_patterns is None:
        volume_patterns = list(DEFAULT_RULE_CONFIG.volume_patterns)
    if not isinstance(volume_patterns, list) or not all(isinstance(p, str) for p in volume_patterns):
        raise RuleTemplateError("volume_patterns 必须是字符串数组")

    special_headings = data.get("special_headings")
    if special_headings is None:
        special_headings = list(DEFAULT_RULE_CONFIG.special_headings)
    if not isinstance(special_headings, list) or not all(isinstance(s, str) for s in special_headings):
        raise RuleTemplateError("special_headings 必须是字符串数组")

    try:
        heading_max_len = int(data.get("heading_max_len") or DEFAULT_RULE_CONFIG.heading_max_len)
        heading_max_commas = int(data.get("heading_max_commas") or DEFAULT_RULE_CONFIG.heading_max_commas)
    except (TypeError, ValueError) as exc:
        raise RuleTemplateError("heading_max_len / heading_max_commas 必须是整数") from exc
    if heading_max_len < 0:
        raise RuleTemplateError("heading_max_len 不能小于 0")
    if heading_max_commas < 0:
        raise RuleTemplateError("heading_max_commas 不能小于 0")

    skip_candidate_re = str(data.get("skip_candidate_re") or DEFAULT_RULE_CONFIG.skip_candidate_re)

    config = RuleConfig(
        rule_id=rule_id,
        name=name,
        chapter_patterns=list(chapter_patterns),
        volume_patterns=list(volume_patterns),
        special_headings=list(special_headings),
        heading_max_len=heading_max_len,
        heading_max_commas=heading_max_commas,
        skip_candidate_re=skip_candidate_re,
    )
    try:
        build_rules(config)
    except re.error as exc:
        raise RuleTemplateError(f"正则编译失败：{exc}") from exc

    known_keys = {
        "id",
        "name",
        "description",
        "version",
        "chapter_patterns",
        "volume_patterns",
        "special_headings",
        "heading_max_len",
        "heading_max_commas",
        "skip_candidate_re",
    }
    extras = {k: v for k, v in data.items() if k not in known_keys}

    normalized: dict = {
        "id": rule_id,
        "name": name,
        "version": version,
        "chapter_patterns": list(chapter_patterns),
        "volume_patterns": list(volume_patterns),
        "special_headings": list(special_headings),
        "heading_max_len": heading_max_len,
        "heading_max_commas": heading_max_commas,
        "skip_candidate_re": skip_candidate_re,
    }
    if description is not None:
        normalized["description"] = description
    normalized.update(extras)
    return normalized


def rules_dir() -> Path:
    env = os.getenv(RULES_DIR_ENV)
    if env:
        path = Path(env)
    else:
        path = _templates_parent_dir() / "rules"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _templates_parent_dir() -> Path:
    env = os.getenv(TEMPLATES_DIR_ENV)
    path = Path(env) if env else DEFAULT_RUNTIME_TEMPLATES_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_default_rules() -> None:
    path = rules_dir()
    default_file = path / "default.json"
    if default_file.exists():
        return
    seed_default = SEED_RULES_DIR / "default.json"
    if seed_default.exists():
        shutil.copy2(seed_default, default_file)
        return
    data = {
        "id": DEFAULT_RULE_CONFIG.rule_id,
        "name": DEFAULT_RULE_CONFIG.name,
        "description": "默认切章规则",
        "version": "1",
        "chapter_patterns": DEFAULT_RULE_CONFIG.chapter_patterns,
        "volume_patterns": DEFAULT_RULE_CONFIG.volume_patterns,
        "special_headings": DEFAULT_RULE_CONFIG.special_headings,
        "heading_max_len": DEFAULT_RULE_CONFIG.heading_max_len,
        "heading_max_commas": DEFAULT_RULE_CONFIG.heading_max_commas,
        "skip_candidate_re": DEFAULT_RULE_CONFIG.skip_candidate_re,
    }
    default_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_rule_templates() -> list[RuleTemplate]:
    ensure_default_rules()
    templates: list[RuleTemplate] = []
    for file_path in sorted(rules_dir().glob("*.json")):
        try:
            data = json.loads(file_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        rule_id = str(data.get("id") or file_path.stem)
        name = str(data.get("name") or rule_id)
        description = data.get("description")
        version = str(data.get("version") or "1")
        config = RuleConfig(
            rule_id=rule_id,
            name=name,
            chapter_patterns=list(data.get("chapter_patterns") or DEFAULT_RULE_CONFIG.chapter_patterns),
            volume_patterns=list(data.get("volume_patterns") or DEFAULT_RULE_CONFIG.volume_patterns),
            special_headings=list(data.get("special_headings") or DEFAULT_RULE_CONFIG.special_headings),
            heading_max_len=int(data.get("heading_max_len") or DEFAULT_RULE_CONFIG.heading_max_len),
            heading_max_commas=int(data.get("heading_max_commas") or DEFAULT_RULE_CONFIG.heading_max_commas),
            skip_candidate_re=str(data.get("skip_candidate_re") or DEFAULT_RULE_CONFIG.skip_candidate_re),
        )
        templates.append(
            RuleTemplate(
                rule_id=rule_id,
                name=name,
                description=description,
                version=version,
                file_path=file_path,
                rules=build_rules(config),
            )
        )
    return templates


def get_rule(rule_id: str) -> RuleTemplate:
    templates = load_rule_templates()
    for template in templates:
        if template.rule_id == rule_id:
            return template
    return templates[0]
