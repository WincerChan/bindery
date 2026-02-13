from __future__ import annotations

import io
import itertools
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Optional, Union

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


@dataclass(frozen=True)
class ParsedBookHeader:
    title: str
    author: Optional[str]
    intro: Optional[str]


@dataclass(frozen=True)
class ParsedBookSection:
    kind: str
    title: str
    lines: list[str]
    volume_title: Optional[str] = None


ParsedBookEvent = Union[ParsedBookHeader, ParsedBookSection]


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


def _iter_text_lines(text: str) -> Iterable[str]:
    with io.StringIO(text) as stream:
        for raw in stream:
            yield raw.rstrip("\r\n")


def _parse_body_lines(book: Book, body_lines: Iterable[str], rules: RuleSet) -> None:
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

    iterator = iter(body_lines)
    prev_line: Optional[str] = None
    line = next(iterator, None)
    next_line = next(iterator, None)

    while line is not None:
        heading_type = classify_heading(line, prev_line, next_line, rules)
        if heading_type == "volume":
            current_chapter = None
            current_volume = start_volume(line.strip())
        elif heading_type == "chapter":
            current_chapter = start_chapter(line.strip(), current_volume)
        else:
            content = normalize_content_line(line)
            if content:
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

        prev_line = line
        line = next_line
        next_line = next(iterator, None)


def _iter_body_section_events(body_lines: Iterable[str], rules: RuleSet) -> Iterator[ParsedBookSection]:
    current_volume_title: Optional[str] = None
    current_volume_lines: list[str] = []

    current_chapter_title: Optional[str] = None
    current_chapter_lines: list[str] = []
    current_chapter_volume_title: Optional[str] = None

    def pop_chapter() -> Optional[ParsedBookSection]:
        nonlocal current_chapter_title, current_chapter_lines, current_chapter_volume_title
        if current_chapter_title is None:
            return None
        section = ParsedBookSection(
            kind="chapter",
            title=current_chapter_title,
            lines=current_chapter_lines,
            volume_title=current_chapter_volume_title,
        )
        current_chapter_title = None
        current_chapter_lines = []
        current_chapter_volume_title = None
        return section

    def pop_volume_lines() -> Optional[ParsedBookSection]:
        nonlocal current_volume_lines
        if current_volume_title is None or not current_volume_lines:
            return None
        section = ParsedBookSection(
            kind="volume",
            title=current_volume_title,
            lines=current_volume_lines,
            volume_title=None,
        )
        current_volume_lines = []
        return section

    iterator = iter(body_lines)
    prev_line: Optional[str] = None
    line = next(iterator, None)
    next_line = next(iterator, None)

    while line is not None:
        heading_type = classify_heading(line, prev_line, next_line, rules)
        if heading_type == "volume":
            chapter_section = pop_chapter()
            if chapter_section is not None:
                yield chapter_section
            volume_section = pop_volume_lines()
            if volume_section is not None:
                yield volume_section
            current_volume_title = line.strip()
            current_volume_lines = []
        elif heading_type == "chapter":
            chapter_section = pop_chapter()
            if chapter_section is not None:
                yield chapter_section
            volume_section = pop_volume_lines()
            if volume_section is not None:
                yield volume_section
            current_chapter_title = line.strip()
            current_chapter_lines = []
            current_chapter_volume_title = current_volume_title
        else:
            content = normalize_content_line(line)
            if content:
                if current_chapter_title is not None:
                    current_chapter_lines.append(content)
                elif current_volume_title is not None:
                    current_volume_lines.append(content)
                else:
                    if current_chapter_title is None:
                        current_chapter_title = "正文"
                        current_chapter_lines = []
                        current_chapter_volume_title = None
                    current_chapter_lines.append(content)

        prev_line = line
        line = next_line
        next_line = next(iterator, None)

    chapter_section = pop_chapter()
    if chapter_section is not None:
        yield chapter_section
    volume_section = pop_volume_lines()
    if volume_section is not None:
        yield volume_section


def _parse_book_events_from_lines(lines_iter: Iterable[str], source_name: str, rules: RuleSet) -> Iterator[ParsedBookEvent]:
    prelude_lines: list[str] = []
    first_heading_line: Optional[str] = None
    first_heading_next: Optional[str] = None

    prev_line: Optional[str] = None
    current_line = next(lines_iter, None)
    next_line = next(lines_iter, None)

    while current_line is not None:
        if classify_heading(current_line, prev_line, next_line, rules) is not None:
            first_heading_line = current_line
            first_heading_next = next_line
            break
        prelude_lines.append(current_line)
        prev_line = current_line
        current_line = next_line
        next_line = next(lines_iter, None)

    title, author, intro, skip_idx = parse_metadata(prelude_lines, rules)
    header = ParsedBookHeader(title=title or source_name, author=author, intro=intro)
    yield header

    prelude_body_iter = (line for idx, line in enumerate(prelude_lines) if idx not in skip_idx)
    if first_heading_line is None:
        body_iter = prelude_body_iter
    else:
        heading_head = [first_heading_line]
        if first_heading_next is not None:
            heading_head.append(first_heading_next)
        body_iter = itertools.chain(prelude_body_iter, heading_head, lines_iter)

    yield from _iter_body_section_events(body_iter, rules)


def _parse_book_from_lines(lines_iter: Iterable[str], source_name: str, rules: RuleSet) -> Book:
    prelude_lines: list[str] = []
    first_heading_line: Optional[str] = None
    first_heading_next: Optional[str] = None

    prev_line: Optional[str] = None
    current_line = next(lines_iter, None)
    next_line = next(lines_iter, None)

    while current_line is not None:
        if classify_heading(current_line, prev_line, next_line, rules) is not None:
            first_heading_line = current_line
            first_heading_next = next_line
            break
        prelude_lines.append(current_line)
        prev_line = current_line
        current_line = next_line
        next_line = next(lines_iter, None)

    title, author, intro, skip_idx = parse_metadata(prelude_lines, rules)
    book = Book(title=title or source_name, author=author, intro=intro)

    prelude_body_iter = (line for idx, line in enumerate(prelude_lines) if idx not in skip_idx)
    if first_heading_line is None:
        body_iter = prelude_body_iter
    else:
        heading_head = [first_heading_line]
        if first_heading_next is not None:
            heading_head.append(first_heading_next)
        body_iter = itertools.chain(prelude_body_iter, heading_head, lines_iter)

    _parse_body_lines(book, body_iter, rules)
    return book


def parse_book(text: str, source_name: str, rules: Optional[RuleSet] = None) -> Book:
    rules = rules or DEFAULT_RULES
    return _parse_book_from_lines(_iter_text_lines(text), source_name, rules)


def _iter_decoded_file_lines(path: Path, encoding: str, *, errors: str) -> Iterable[str]:
    with path.open("r", encoding=encoding, errors=errors) as stream:
        for raw in stream:
            yield raw.rstrip("\r\n")


def _resolve_file_encoding(path: Path) -> tuple[str, str]:
    for enc in ENCODING_CANDIDATES:
        try:
            with path.open("r", encoding=enc, errors="strict") as stream:
                for _ in stream:
                    pass
            return enc, "strict"
        except UnicodeDecodeError:
            continue
    return "utf-8", "replace"


def parse_book_file(path: Path, source_name: str, rules: Optional[RuleSet] = None) -> Book:
    rules = rules or DEFAULT_RULES
    for enc in ENCODING_CANDIDATES:
        try:
            return _parse_book_from_lines(_iter_decoded_file_lines(path, enc, errors="strict"), source_name, rules)
        except UnicodeDecodeError:
            continue
    return _parse_book_from_lines(_iter_decoded_file_lines(path, "utf-8", errors="replace"), source_name, rules)


def parse_book_file_events(path: Path, source_name: str, rules: Optional[RuleSet] = None) -> Iterator[ParsedBookEvent]:
    rules = rules or DEFAULT_RULES
    encoding, errors = _resolve_file_encoding(path)
    yield from _parse_book_events_from_lines(_iter_decoded_file_lines(path, encoding, errors=errors), source_name, rules)


def text_file_has_content(path: Path) -> bool:
    for enc in ENCODING_CANDIDATES:
        try:
            for line in _iter_decoded_file_lines(path, enc, errors="strict"):
                if line.strip():
                    return True
            return False
        except UnicodeDecodeError:
            continue
    for line in _iter_decoded_file_lines(path, "utf-8", errors="replace"):
        if line.strip():
            return True
    return False
