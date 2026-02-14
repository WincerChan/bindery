from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Chapter:
    title: str
    lines: list[str] = field(default_factory=list)
    volume: Optional["Volume"] = None


@dataclass
class Volume:
    title: str
    lines: list[str] = field(default_factory=list)
    chapters: list[Chapter] = field(default_factory=list)


@dataclass
class Book:
    title: str
    author: Optional[str]
    intro: Optional[str]
    volumes: list[Volume] = field(default_factory=list)
    root_chapters: list[Chapter] = field(default_factory=list)
    spine: list[object] = field(default_factory=list)


@dataclass
class Metadata:
    book_id: str
    title: str
    author: Optional[str]
    language: str
    description: Optional[str]
    source_type: str = "txt"
    series: Optional[str] = None
    identifier: Optional[str] = None
    publisher: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    published: Optional[str] = None
    isbn: Optional[str] = None
    rating: Optional[int] = None
    status: str = "synced"
    epub_updated_at: Optional[str] = None
    archived: bool = False
    read: bool = False
    read_updated_at: Optional[str] = None
    cover_file: Optional[str] = None
    rule_template: Optional[str] = None
    theme_template: Optional[str] = None
    custom_css: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class Job:
    id: str
    book_id: Optional[str]
    action: str
    status: str
    stage: Optional[str]
    message: Optional[str]
    log: Optional[str]
    rule_template: Optional[str]
    created_at: str
    updated_at: str


@dataclass
class Wish:
    id: str
    title: str
    library_book_id: Optional[str] = None
    author: Optional[str] = None
    rating: Optional[int] = None
    read: bool = False
    read_status: str = "unread"
    tags: list[str] = field(default_factory=list)
    comment: Optional[str] = None
    book_status: str = "ongoing"
    created_at: str = ""
    updated_at: str = ""


def chapter_to_dict(chapter: Chapter) -> dict:
    return {
        "title": chapter.title,
        "lines": list(chapter.lines),
    }


def chapter_from_dict(data: dict, volume: Optional[Volume] = None) -> Chapter:
    chapter = Chapter(title=data.get("title", ""), lines=list(data.get("lines", [])), volume=volume)
    return chapter


def volume_to_dict(volume: Volume) -> dict:
    return {
        "title": volume.title,
        "lines": list(volume.lines),
        "chapters": [chapter_to_dict(chapter) for chapter in volume.chapters],
    }


def volume_from_dict(data: dict) -> Volume:
    volume = Volume(title=data.get("title", ""), lines=list(data.get("lines", [])))
    volume.chapters = [chapter_from_dict(chap, volume=volume) for chap in data.get("chapters", [])]
    return volume


def book_to_dict(book: Book) -> dict:
    volume_index = {id(vol): idx for idx, vol in enumerate(book.volumes)}
    root_index = {id(chap): idx for idx, chap in enumerate(book.root_chapters)}
    volume_chapter_index: dict[tuple[int, int], int] = {}
    for vol_idx, vol in enumerate(book.volumes):
        for chap_idx, chap in enumerate(vol.chapters):
            volume_chapter_index[(vol_idx, id(chap))] = chap_idx

    spine_entries: list[dict] = []
    for item in book.spine:
        if isinstance(item, Volume):
            spine_entries.append({"type": "volume", "index": volume_index.get(id(item), 0)})
            continue
        if item.volume is not None:
            vol_idx = volume_index.get(id(item.volume), 0)
            chap_idx = volume_chapter_index.get((vol_idx, id(item)), 0)
            spine_entries.append(
                {
                    "type": "chapter",
                    "scope": "volume",
                    "volume_index": vol_idx,
                    "chapter_index": chap_idx,
                }
            )
        else:
            spine_entries.append({"type": "chapter", "scope": "root", "index": root_index.get(id(item), 0)})

    return {
        "title": book.title,
        "author": book.author,
        "intro": book.intro,
        "volumes": [volume_to_dict(vol) for vol in book.volumes],
        "root_chapters": [chapter_to_dict(chap) for chap in book.root_chapters],
        "spine": spine_entries,
    }


def book_from_dict(data: dict) -> Book:
    book = Book(
        title=data.get("title", ""),
        author=data.get("author"),
        intro=data.get("intro"),
    )
    book.volumes = [volume_from_dict(vol) for vol in data.get("volumes", [])]
    book.root_chapters = [chapter_from_dict(chap) for chap in data.get("root_chapters", [])]

    for vol in book.volumes:
        for chap in vol.chapters:
            chap.volume = vol

    spine_entries = data.get("spine", [])
    if spine_entries:
        book.spine = []
        for entry in spine_entries:
            if entry.get("type") == "volume":
                idx = entry.get("index", 0)
                if 0 <= idx < len(book.volumes):
                    book.spine.append(book.volumes[idx])
                continue
            if entry.get("type") == "chapter":
                scope = entry.get("scope")
                if scope == "volume":
                    vol_idx = entry.get("volume_index", 0)
                    chap_idx = entry.get("chapter_index", 0)
                    if 0 <= vol_idx < len(book.volumes):
                        chapters = book.volumes[vol_idx].chapters
                        if 0 <= chap_idx < len(chapters):
                            book.spine.append(chapters[chap_idx])
                    continue
                idx = entry.get("index", 0)
                if 0 <= idx < len(book.root_chapters):
                    book.spine.append(book.root_chapters[idx])
        if not book.spine:
            spine_entries = []

    if not spine_entries:
        book.spine = []
        for vol in book.volumes:
            book.spine.append(vol)
            for chap in vol.chapters:
                book.spine.append(chap)
        for chap in book.root_chapters:
            book.spine.append(chap)
    return book


def metadata_to_dict(meta: Metadata) -> dict:
    return {
        "book_id": meta.book_id,
        "title": meta.title,
        "author": meta.author,
        "language": meta.language,
        "description": meta.description,
        "source_type": meta.source_type,
        "series": meta.series,
        "identifier": meta.identifier,
        "publisher": meta.publisher,
        "tags": list(meta.tags),
        "published": meta.published,
        "isbn": meta.isbn,
        "rating": meta.rating,
        "status": meta.status,
        "epub_updated_at": meta.epub_updated_at,
        "archived": meta.archived,
        "read": meta.read,
        "read_updated_at": meta.read_updated_at,
        "cover_file": meta.cover_file,
        "rule_template": meta.rule_template,
        "theme_template": meta.theme_template,
        "custom_css": meta.custom_css,
        "created_at": meta.created_at,
        "updated_at": meta.updated_at,
    }


def metadata_from_dict(data: dict) -> Metadata:
    return Metadata(
        book_id=data.get("book_id", ""),
        title=data.get("title", ""),
        author=data.get("author"),
        language=data.get("language", "zh-CN"),
        description=data.get("description"),
        source_type=data.get("source_type", "txt"),
        series=data.get("series"),
        identifier=data.get("identifier"),
        publisher=data.get("publisher"),
        tags=list(data.get("tags", [])),
        published=data.get("published"),
        isbn=data.get("isbn"),
        rating=data.get("rating"),
        status=data.get("status", "synced"),
        epub_updated_at=data.get("epub_updated_at"),
        archived=bool(data.get("archived", False)),
        read=bool(data.get("read", False)),
        read_updated_at=data.get("read_updated_at"),
        cover_file=data.get("cover_file"),
        rule_template=data.get("rule_template"),
        theme_template=data.get("theme_template"),
        custom_css=data.get("custom_css"),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
    )
