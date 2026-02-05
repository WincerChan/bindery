from __future__ import annotations

import imghdr
import json
import os
from pathlib import Path
import shutil
import uuid

from .models import Book, Metadata, book_from_dict, book_to_dict, metadata_from_dict, metadata_to_dict

META_FILE = "meta.json"
BOOK_FILE = "book.json"
SOURCE_FILE = "source.txt"
EPUB_FILE = "book.epub"
COVER_PREFIX = "cover"


def library_dir() -> Path:
    env = os.getenv("BINDERY_LIBRARY_DIR")
    base = Path(env) if env else Path(__file__).resolve().parent.parent / "library"
    base.mkdir(parents=True, exist_ok=True)
    return base


def new_book_id() -> str:
    return uuid.uuid4().hex


def book_dir(base: Path, book_id: str) -> Path:
    return base / book_id


def archive_dir(base: Path) -> Path:
    path = base / "archive"
    path.mkdir(parents=True, exist_ok=True)
    return path


def archive_book_dir(base: Path, book_id: str) -> Path:
    return archive_dir(base) / book_id


def epub_path(base: Path, book_id: str) -> Path:
    return book_dir(base, book_id) / EPUB_FILE


def source_path(base: Path, book_id: str) -> Path:
    return book_dir(base, book_id) / SOURCE_FILE


def cover_path(base: Path, book_id: str, filename: str) -> Path:
    return book_dir(base, book_id) / filename


def save_cover_bytes(base: Path, book_id: str, data: bytes, filename: str | None) -> str:
    ext = Path(filename or "").suffix.lower()
    if not ext:
        kind = imghdr.what(None, data)
        if kind == "jpeg":
            ext = ".jpg"
        elif kind == "png":
            ext = ".png"
        elif kind == "gif":
            ext = ".gif"
        elif kind == "webp":
            ext = ".webp"
    if not ext:
        ext = ".jpg"
    target_name = f"{COVER_PREFIX}{ext}"
    path = cover_path(base, book_id, target_name)
    path.write_bytes(data)
    return target_name


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_book(book: Book, base: Path, book_id: str) -> None:
    path = book_dir(base, book_id)
    path.mkdir(parents=True, exist_ok=True)
    _write_json(path / BOOK_FILE, book_to_dict(book))


def load_book(base: Path, book_id: str) -> Book:
    path = book_dir(base, book_id) / BOOK_FILE
    data = _read_json(path)
    return book_from_dict(data)


def save_metadata(meta: Metadata, base: Path) -> None:
    path = book_dir(base, meta.book_id)
    path.mkdir(parents=True, exist_ok=True)
    _write_json(path / META_FILE, metadata_to_dict(meta))


def load_metadata(base: Path, book_id: str) -> Metadata:
    path = book_dir(base, book_id) / META_FILE
    data = _read_json(path)
    return metadata_from_dict(data)


def list_books(base: Path) -> list[Metadata]:
    if not base.exists():
        return []
    books: list[Metadata] = []
    for entry in base.iterdir():
        if not entry.is_dir():
            continue
        if entry.name == "archive":
            continue
        meta_path = entry / META_FILE
        if not meta_path.exists():
            continue
        try:
            data = _read_json(meta_path)
            meta = metadata_from_dict(data)
            if meta.archived:
                continue
            books.append(meta)
        except json.JSONDecodeError:
            continue
    books.sort(key=lambda item: item.updated_at or item.created_at, reverse=True)
    return books


def list_archived_books(base: Path) -> list[Metadata]:
    archive = archive_dir(base)
    if not archive.exists():
        return []
    books: list[Metadata] = []
    for entry in archive.iterdir():
        if not entry.is_dir():
            continue
        meta_path = entry / META_FILE
        if not meta_path.exists():
            continue
        try:
            data = _read_json(meta_path)
            meta = metadata_from_dict(data)
            meta.archived = True
            books.append(meta)
        except json.JSONDecodeError:
            continue
    books.sort(key=lambda item: item.updated_at or item.created_at, reverse=True)
    return books


def write_source_text(base: Path, book_id: str, text: str) -> None:
    path = book_dir(base, book_id)
    path.mkdir(parents=True, exist_ok=True)
    (path / SOURCE_FILE).write_text(text, encoding="utf-8")


def read_source_text(base: Path, book_id: str) -> str:
    return (book_dir(base, book_id) / SOURCE_FILE).read_text(encoding="utf-8")


def ensure_book_exists(base: Path, book_id: str) -> bool:
    path = book_dir(base, book_id)
    return path.is_dir() and (path / META_FILE).exists() and (path / BOOK_FILE).exists()


def delete_book(base: Path, book_id: str) -> None:
    path = book_dir(base, book_id)
    if not path.exists():
        path = archive_book_dir(base, book_id)
        if not path.exists():
            return
    shutil.rmtree(path)


def archive_book(base: Path, book_id: str) -> None:
    src = book_dir(base, book_id)
    if not src.exists():
        return
    dest = archive_book_dir(base, book_id)
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))
