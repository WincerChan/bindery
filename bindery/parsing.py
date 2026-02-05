from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .models import Book, Chapter, Volume

ENCODING_CANDIDATES = ("utf-8-sig", "utf-8", "gb18030")

LABEL_RE = re.compile(
    r"^\s*(书名|作者|作\s*者|内容简介|简介|内容介绍|文案)\s*[:：]\s*(.*)\s*$"
)

TITLE_ONLY_RE = re.compile(r"^《(.+)》$")

SENTENCE_END_RE = re.compile(r"[。！？]$")
COMMA_RE = re.compile(r"[，,]")


@dataclass(frozen=True)
class RuleConfig:
    rule_id: str
    name: str
    chapter_patterns: list[str]
    volume_patterns: list[str]
    special_headings: list[str]
    heading_max_len: int = 40
    heading_max_commas: int = 1
    skip_candidate_re: str = r"(http|www|QQ群|群|公众号|微信|下载|txt|整理|校对|打包|本书|电子书)"


@dataclass(frozen=True)
class RuleSet:
    config: RuleConfig
    chapter_patterns: list[re.Pattern[str]]
    volume_patterns: list[re.Pattern[str]]
    special_headings: list[str]
    heading_max_len: int
    heading_max_commas: int
    skip_candidate_re: re.Pattern[str]


def build_rules(config: RuleConfig) -> RuleSet:
    chapter_patterns = [re.compile(pattern) for pattern in config.chapter_patterns]
    volume_patterns = [re.compile(pattern) for pattern in config.volume_patterns]
    return RuleSet(
        config=config,
        chapter_patterns=chapter_patterns,
        volume_patterns=volume_patterns,
        special_headings=list(config.special_headings),
        heading_max_len=config.heading_max_len,
        heading_max_commas=config.heading_max_commas,
        skip_candidate_re=re.compile(config.skip_candidate_re),
    )


DEFAULT_RULE_CONFIG = RuleConfig(
    rule_id="default",
    name="默认",
    chapter_patterns=[
        r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*章.*$",
        r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*节.*$",
        r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*回.*$",
        r"(?i)^Chapter\s+\d+.*$",
    ],
    volume_patterns=[
        r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*卷.*$",
        r"^卷\s*[0-9一二三四五六七八九十百千万两零〇]+.*$",
        r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*部.*$",
    ],
    special_headings=[
        "序章",
        "序",
        "楔子",
        "引子",
        "前言",
        "前序",
        "后记",
        "后序",
        "尾声",
        "结语",
        "终章",
        "终卷",
        "终篇",
        "番外",
        "番外篇",
        "作者的话",
        "完结感言",
    ],
)

DEFAULT_RULES = build_rules(DEFAULT_RULE_CONFIG)


def decode_text(data: bytes) -> str:
    for enc in ENCODING_CANDIDATES:
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def read_text(path: Path) -> str:
    data = path.read_bytes()
    return decode_text(data)


def is_heading(
    line: str,
    prev_line: Optional[str] = None,
    next_line: Optional[str] = None,
    rules: RuleSet = DEFAULT_RULES,
) -> bool:
    return classify_heading(line, prev_line, next_line, rules) is not None


def is_likely_heading_line(
    line: str,
    prev_line: Optional[str],
    next_line: Optional[str],
    rules: RuleSet,
) -> bool:
    s = line.strip()
    if not s:
        return False

    prev_blank = prev_line is None or not prev_line.strip()
    next_blank = next_line is None or not next_line.strip()
    isolated = prev_blank or next_blank

    if SENTENCE_END_RE.search(s) and not isolated:
        return False

    if len(s) > rules.heading_max_len and not isolated:
        return False

    if len(COMMA_RE.findall(s)) > rules.heading_max_commas and not isolated:
        return False

    return True


def classify_heading(
    line: str,
    prev_line: Optional[str] = None,
    next_line: Optional[str] = None,
    rules: RuleSet = DEFAULT_RULES,
) -> Optional[str]:
    s = line.strip()
    if not s:
        return None
    for pattern in rules.chapter_patterns:
        if pattern.match(s):
            return "chapter" if is_likely_heading_line(line, prev_line, next_line, rules) else None
    for kw in rules.special_headings:
        if s == kw or s.startswith(kw + " ") or s.startswith(kw + "：") or s.startswith(kw + ":"):
            return "chapter" if is_likely_heading_line(line, prev_line, next_line, rules) else None
    for pattern in rules.volume_patterns:
        if pattern.match(s):
            return "volume" if is_likely_heading_line(line, prev_line, next_line, rules) else None
    return None


def parse_metadata(lines: list[str], rules: RuleSet) -> tuple[Optional[str], Optional[str], Optional[str], set[int]]:
    title = None
    author = None
    intro_lines: list[str] = []
    skip_idx: set[int] = set()
    candidates: list[tuple[int, str]] = []
    pending_label: Optional[str] = None
    in_intro = False

    first_heading_idx = None
    for i, line in enumerate(lines):
        prev_line = lines[i - 1] if i > 0 else None
        next_line = lines[i + 1] if i + 1 < len(lines) else None
        if is_heading(line, prev_line, next_line, rules):
            first_heading_idx = i
            break

    scan_limit = first_heading_idx if first_heading_idx is not None else len(lines)
    non_empty_seen = 0

    for i in range(scan_limit):
        raw = lines[i]
        prev_line = lines[i - 1] if i > 0 else None
        next_line = lines[i + 1] if i + 1 < len(lines) else None
        s = raw.strip()
        if not s:
            if in_intro and intro_lines:
                in_intro = False
            continue

        if in_intro:
            if is_heading(raw, prev_line, next_line, rules):
                break
            intro_lines.append(s)
            skip_idx.add(i)
            continue

        m = LABEL_RE.match(s)
        if m:
            label = m.group(1)
            value = m.group(2).strip()
            skip_idx.add(i)
            if label in ("书名",):
                if value:
                    title = value
                else:
                    pending_label = "title"
            elif label in ("作者", "作 者"):
                if value:
                    author = value
                else:
                    pending_label = "author"
            else:
                if value:
                    intro_lines.append(value)
                in_intro = True
            continue

        if s in ("书名", "书 名"):
            pending_label = "title"
            skip_idx.add(i)
            continue
        if s in ("作者", "作 者"):
            pending_label = "author"
            skip_idx.add(i)
            continue
        if s in ("内容简介", "简介", "内容介绍", "文案"):
            in_intro = True
            skip_idx.add(i)
            continue

        if pending_label and (s.startswith("：") or s.startswith(":")):
            value = s[1:].strip()
            skip_idx.add(i)
            if pending_label == "title" and value:
                title = value
            elif pending_label == "author" and value:
                author = value
            pending_label = None
            continue

        m_title_only = TITLE_ONLY_RE.match(s)
        if m_title_only and title is None:
            title = m_title_only.group(1).strip()
            skip_idx.add(i)
            continue

        non_empty_seen += 1
        if non_empty_seen <= 6 and not rules.skip_candidate_re.search(s):
            candidates.append((i, s))

    if title is None and candidates:
        idx, value = candidates[0]
        title = value
        skip_idx.add(idx)

    if author is None and len(candidates) >= 2:
        idx, value = candidates[1]
        if value != title:
            author = value
            skip_idx.add(idx)

    intro = "\n".join(intro_lines).strip() if intro_lines else None
    return title, author, intro, skip_idx


def normalize_content_line(line: str) -> str:
    s = line.strip()
    if not s:
        return ""
    return s.replace("\u3000", "")


def parse_book(text: str, source_name: str, rules: Optional[RuleSet] = None) -> Book:
    rules = rules or DEFAULT_RULES
    lines = text.splitlines()
    title, author, intro, skip_idx = parse_metadata(lines, rules)

    body_lines = [line for idx, line in enumerate(lines) if idx not in skip_idx]
    while body_lines and not body_lines[0].strip():
        body_lines.pop(0)

    book = Book(title=title or source_name, author=author, intro=intro)

    current_volume: Optional[Volume] = None
    current_chapter: Optional[Chapter] = None

    def start_volume(heading: str) -> Volume:
        vol = Volume(title=heading)
        book.volumes.append(vol)
        book.spine.append(vol)
        return vol

    def start_chapter(heading: str, volume: Optional[Volume]) -> Chapter:
        chap = Chapter(title=heading, volume=volume)
        if volume:
            volume.chapters.append(chap)
        else:
            book.root_chapters.append(chap)
        book.spine.append(chap)
        return chap

    for idx, line in enumerate(body_lines):
        prev_line = body_lines[idx - 1] if idx > 0 else None
        next_line = body_lines[idx + 1] if idx + 1 < len(body_lines) else None
        heading_type = classify_heading(line, prev_line, next_line, rules)
        if heading_type == "volume":
            current_chapter = None
            current_volume = start_volume(line.strip())
            continue
        if heading_type == "chapter":
            current_chapter = start_chapter(line.strip(), current_volume)
            continue

        content = normalize_content_line(line)
        if not content:
            continue

        if current_chapter:
            current_chapter.lines.append(content)
        elif current_volume:
            current_volume.lines.append(content)
        else:
            if not book.root_chapters:
                current_chapter = start_chapter("正文", None)
            else:
                current_chapter = book.root_chapters[-1]
            current_chapter.lines.append(content)

    return book
