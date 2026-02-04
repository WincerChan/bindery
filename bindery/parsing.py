from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from .models import Book, Chapter, Volume

ENCODING_CANDIDATES = ("utf-8-sig", "utf-8", "gb18030")

LABEL_RE = re.compile(
    r"^\s*(书名|作者|作\s*者|内容简介|简介|内容介绍|文案)\s*[:：]\s*(.*)\s*$"
)

TITLE_ONLY_RE = re.compile(r"^《(.+)》$")

CHAPTER_PATTERNS = [
    re.compile(r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*章.*$"),
    re.compile(r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*节.*$"),
    re.compile(r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*回.*$"),
    re.compile(r"^Chapter\s+\d+.*$", re.IGNORECASE),
]

VOLUME_PATTERNS = [
    re.compile(r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*卷.*$"),
    re.compile(r"^卷\s*[0-9一二三四五六七八九十百千万两零〇]+.*$"),
    re.compile(r"^第\s*[0-9一二三四五六七八九十百千万两零〇]+\s*部.*$"),
]

SPECIAL_HEADINGS = [
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
]

SKIP_CANDIDATE_RE = re.compile(r"(http|www|QQ群|群|公众号|微信|下载|txt|整理|校对|打包|本书|电子书)")
SENTENCE_END_RE = re.compile(r"[。！？]$")
COMMA_RE = re.compile(r"[，,]")
HEADING_MAX_LEN = 40
HEADING_MAX_COMMAS = 1


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


def is_heading(line: str, prev_line: Optional[str] = None, next_line: Optional[str] = None) -> bool:
    return classify_heading(line, prev_line, next_line) is not None


def is_likely_heading_line(line: str, prev_line: Optional[str], next_line: Optional[str]) -> bool:
    s = line.strip()
    if not s:
        return False

    prev_blank = prev_line is None or not prev_line.strip()
    next_blank = next_line is None or not next_line.strip()
    isolated = prev_blank or next_blank

    if SENTENCE_END_RE.search(s) and not isolated:
        return False

    if len(s) > HEADING_MAX_LEN and not isolated:
        return False

    if len(COMMA_RE.findall(s)) > HEADING_MAX_COMMAS and not isolated:
        return False

    return True


def classify_heading(line: str, prev_line: Optional[str] = None, next_line: Optional[str] = None) -> Optional[str]:
    s = line.strip()
    if not s:
        return None
    for pattern in CHAPTER_PATTERNS:
        if pattern.match(s):
            return "chapter" if is_likely_heading_line(line, prev_line, next_line) else None
    for kw in SPECIAL_HEADINGS:
        if s == kw or s.startswith(kw + " ") or s.startswith(kw + "：") or s.startswith(kw + ":"):
            return "chapter" if is_likely_heading_line(line, prev_line, next_line) else None
    for pattern in VOLUME_PATTERNS:
        if pattern.match(s):
            return "volume" if is_likely_heading_line(line, prev_line, next_line) else None
    return None


def parse_metadata(lines: list[str]) -> tuple[Optional[str], Optional[str], Optional[str], set[int]]:
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
        if is_heading(line, prev_line, next_line):
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
            if is_heading(raw, prev_line, next_line):
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
        if non_empty_seen <= 6 and not SKIP_CANDIDATE_RE.search(s):
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


def parse_book(text: str, source_name: str) -> Book:
    lines = text.splitlines()
    title, author, intro, skip_idx = parse_metadata(lines)

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
        heading_type = classify_heading(line, prev_line, next_line)
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
