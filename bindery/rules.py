from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .parsing import DEFAULT_RULE_CONFIG, RuleConfig, RuleSet, build_rules

BASE_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class RuleTemplate:
    rule_id: str
    name: str
    description: Optional[str]
    version: str
    file_path: Path
    rules: RuleSet


def rules_dir() -> Path:
    path = BASE_DIR / "rules"
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_default_rules() -> None:
    path = rules_dir()
    default_file = path / "default.json"
    if default_file.exists():
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
