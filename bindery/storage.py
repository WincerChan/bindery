from __future__ import annotations

import imghdr
import json
import sqlite3
from pathlib import Path
import shutil
import threading
import uuid

from .db import db_path, init_db
from .env import read_env
from .models import Book, Metadata, book_from_dict, book_to_dict, metadata_from_dict

META_FILE = "meta.json"
BOOK_FILE = "book.json"
SOURCE_FILE = "source.txt"
EPUB_FILE = "book.epub"
COVER_PREFIX = "cover"

BOOK_COLUMNS = (
    "book_id",
    "title",
    "author",
    "language",
    "description",
    "source_type",
    "series",
    "identifier",
    "publisher",
    "tags_json",
    "published",
    "isbn",
    "rating",
    "status",
    "epub_updated_at",
    "archived",
    "read",
    "read_updated_at",
    "cover_file",
    "rule_template",
    "theme_template",
    "custom_css",
    "created_at",
    "updated_at",
)

_BOOKS_INIT_LOCK = threading.Lock()
_BOOKS_INIT_DONE: set[str] = set()


def library_dir() -> Path:
    env = read_env("BINDERY_LIBRARY_DIR")
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


def _books_db_file() -> Path:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _connect_books_db() -> sqlite3.Connection:
    conn = sqlite3.connect(_books_db_file())
    conn.row_factory = sqlite3.Row
    return conn


def _create_books_table(conn: sqlite3.Connection) -> None:
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS books (
                book_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                author TEXT,
                language TEXT NOT NULL DEFAULT 'zh-CN',
                description TEXT,
                source_type TEXT NOT NULL DEFAULT 'txt',
                series TEXT,
                identifier TEXT,
                publisher TEXT,
                tags_json TEXT NOT NULL DEFAULT '[]',
                published TEXT,
                isbn TEXT,
                rating INTEGER,
                status TEXT NOT NULL DEFAULT 'synced',
                epub_updated_at TEXT,
                archived INTEGER NOT NULL DEFAULT 0,
                read INTEGER NOT NULL DEFAULT 0,
                read_updated_at TEXT,
                cover_file TEXT,
                rule_template TEXT,
                theme_template TEXT,
                custom_css TEXT,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_books_archived ON books(archived)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_books_updated ON books(updated_at DESC)")


def _metadata_to_values(meta: Metadata) -> tuple:
    return (
        meta.book_id,
        meta.title or "",
        meta.author,
        meta.language or "zh-CN",
        meta.description,
        meta.source_type or "txt",
        meta.series,
        meta.identifier,
        meta.publisher,
        json.dumps(list(meta.tags), ensure_ascii=False),
        meta.published,
        meta.isbn,
        meta.rating,
        meta.status or "synced",
        meta.epub_updated_at,
        int(bool(meta.archived)),
        int(bool(meta.read)),
        meta.read_updated_at,
        meta.cover_file,
        meta.rule_template,
        meta.theme_template,
        meta.custom_css,
        meta.created_at or "",
        meta.updated_at or "",
    )


def _row_to_metadata(row: sqlite3.Row) -> Metadata:
    raw_tags = row["tags_json"] if "tags_json" in row.keys() else "[]"
    try:
        parsed_tags = json.loads(raw_tags or "[]")
        tags = parsed_tags if isinstance(parsed_tags, list) else []
    except json.JSONDecodeError:
        tags = []
    return Metadata(
        book_id=row["book_id"],
        title=row["title"] or "",
        author=row["author"],
        language=row["language"] or "zh-CN",
        description=row["description"],
        source_type=row["source_type"] or "txt",
        series=row["series"],
        identifier=row["identifier"],
        publisher=row["publisher"],
        tags=[str(item) for item in tags if str(item).strip()],
        published=row["published"],
        isbn=row["isbn"],
        rating=row["rating"],
        status=row["status"] or "synced",
        epub_updated_at=row["epub_updated_at"],
        archived=bool(row["archived"]),
        read=bool(row["read"]),
        read_updated_at=row["read_updated_at"],
        cover_file=row["cover_file"],
        rule_template=row["rule_template"],
        theme_template=row["theme_template"],
        custom_css=row["custom_css"],
        created_at=row["created_at"] or "",
        updated_at=row["updated_at"] or "",
    )


def _legacy_meta_candidates(base: Path) -> list[tuple[Path, bool]]:
    candidates: list[tuple[Path, bool]] = []
    if base.exists():
        for entry in base.iterdir():
            if not entry.is_dir() or entry.name == "archive":
                continue
            candidates.append((entry / META_FILE, False))
    archive = archive_dir(base)
    if archive.exists():
        for entry in archive.iterdir():
            if not entry.is_dir():
                continue
            candidates.append((entry / META_FILE, True))
    return candidates


def _remove_legacy_meta_files(base: Path, book_id: str) -> None:
    for path in (
        book_dir(base, book_id) / META_FILE,
        archive_book_dir(base, book_id) / META_FILE,
    ):
        path.unlink(missing_ok=True)


def _migrate_legacy_meta_files(base: Path, conn: sqlite3.Connection) -> None:
    for meta_path, archived_default in _legacy_meta_candidates(base):
        if not meta_path.exists():
            continue
        try:
            legacy_meta = metadata_from_dict(_read_json(meta_path))
        except (json.JSONDecodeError, OSError):
            continue
        legacy_meta.book_id = legacy_meta.book_id or meta_path.parent.name
        if not legacy_meta.book_id:
            continue
        exists = conn.execute("SELECT 1 FROM books WHERE book_id = ?", (legacy_meta.book_id,)).fetchone()
        if exists:
            meta_path.unlink(missing_ok=True)
            continue
        legacy_meta.archived = bool(legacy_meta.archived or archived_default)
        _upsert_metadata_row(conn, legacy_meta)
        meta_path.unlink(missing_ok=True)


def _ensure_books_db(base: Path) -> None:
    db_key = str(_books_db_file().resolve())
    with _BOOKS_INIT_LOCK:
        if db_key in _BOOKS_INIT_DONE:
            return
        init_db()
        conn = _connect_books_db()
        try:
            _create_books_table(conn)
            _migrate_legacy_meta_files(base, conn)
        finally:
            conn.close()
        _BOOKS_INIT_DONE.add(db_key)


def _upsert_metadata_row(conn: sqlite3.Connection, meta: Metadata) -> None:
    values = _metadata_to_values(meta)
    with conn:
        conn.execute(
            f"""
            INSERT INTO books ({", ".join(BOOK_COLUMNS)})
            VALUES ({", ".join("?" for _ in BOOK_COLUMNS)})
            ON CONFLICT(book_id) DO UPDATE SET
                title=excluded.title,
                author=excluded.author,
                language=excluded.language,
                description=excluded.description,
                source_type=excluded.source_type,
                series=excluded.series,
                identifier=excluded.identifier,
                publisher=excluded.publisher,
                tags_json=excluded.tags_json,
                published=excluded.published,
                isbn=excluded.isbn,
                rating=excluded.rating,
                status=excluded.status,
                epub_updated_at=excluded.epub_updated_at,
                archived=excluded.archived,
                read=excluded.read,
                read_updated_at=excluded.read_updated_at,
                cover_file=excluded.cover_file,
                rule_template=excluded.rule_template,
                theme_template=excluded.theme_template,
                custom_css=excluded.custom_css,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at
            """,
            values,
        )


def _query_metadata_row(book_id: str) -> Metadata | None:
    conn = _connect_books_db()
    try:
        row = conn.execute("SELECT * FROM books WHERE book_id = ?", (book_id,)).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return _row_to_metadata(row)


def save_book(book: Book, base: Path, book_id: str) -> None:
    path = book_dir(base, book_id)
    path.mkdir(parents=True, exist_ok=True)
    _write_json(path / BOOK_FILE, book_to_dict(book))


def load_book(base: Path, book_id: str) -> Book:
    path = book_dir(base, book_id) / BOOK_FILE
    data = _read_json(path)
    return book_from_dict(data)


def save_metadata(meta: Metadata, base: Path) -> None:
    _ensure_books_db(base)
    path = archive_book_dir(base, meta.book_id) if meta.archived else book_dir(base, meta.book_id)
    path.mkdir(parents=True, exist_ok=True)
    conn = _connect_books_db()
    try:
        _upsert_metadata_row(conn, meta)
    finally:
        conn.close()
    _remove_legacy_meta_files(base, meta.book_id)


def load_metadata(base: Path, book_id: str) -> Metadata:
    _ensure_books_db(base)
    meta = _query_metadata_row(book_id)
    if meta is not None:
        return meta
    for legacy_path, archived_default in (
        (book_dir(base, book_id) / META_FILE, False),
        (archive_book_dir(base, book_id) / META_FILE, True),
    ):
        if not legacy_path.exists():
            continue
        data = _read_json(legacy_path)
        legacy = metadata_from_dict(data)
        legacy.book_id = legacy.book_id or book_id
        legacy.archived = bool(legacy.archived or archived_default)
        save_metadata(legacy, base)
        return legacy
    raise FileNotFoundError(f"Metadata not found for book {book_id}")


def list_books(base: Path, *, sort_output: bool = True) -> list[Metadata]:
    _ensure_books_db(base)
    order_clause = ""
    if sort_output:
        order_clause = """
            ORDER BY
                CASE
                    WHEN updated_at IS NULL OR updated_at = '' THEN created_at
                    ELSE updated_at
                END DESC
        """
    conn = _connect_books_db()
    try:
        rows = conn.execute(f"SELECT * FROM books WHERE archived = 0 {order_clause}").fetchall()
    finally:
        conn.close()
    books = [_row_to_metadata(row) for row in rows]
    return [meta for meta in books if book_dir(base, meta.book_id).is_dir()]


def list_archived_books(base: Path) -> list[Metadata]:
    _ensure_books_db(base)
    conn = _connect_books_db()
    try:
        rows = conn.execute(
            """
            SELECT * FROM books
            WHERE archived = 1
            ORDER BY
                CASE
                    WHEN updated_at IS NULL OR updated_at = '' THEN created_at
                    ELSE updated_at
                END DESC
            """
        ).fetchall()
    finally:
        conn.close()
    books = [_row_to_metadata(row) for row in rows]
    return [meta for meta in books if archive_book_dir(base, meta.book_id).is_dir()]


def write_source_file(base: Path, book_id: str, src_path: Path) -> None:
    path = book_dir(base, book_id)
    path.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src_path, path / SOURCE_FILE)


def ensure_book_exists(base: Path, book_id: str) -> bool:
    try:
        meta = load_metadata(base, book_id)
    except FileNotFoundError:
        return False
    if meta.archived:
        return False
    path = book_dir(base, book_id)
    return path.is_dir() and ((path / BOOK_FILE).exists() or (path / EPUB_FILE).exists())


def _delete_metadata_row(base: Path, book_id: str) -> None:
    _ensure_books_db(base)
    conn = _connect_books_db()
    try:
        with conn:
            conn.execute("DELETE FROM books WHERE book_id = ?", (book_id,))
    finally:
        conn.close()


def _set_metadata_archived(base: Path, book_id: str, archived: bool) -> None:
    _ensure_books_db(base)
    conn = _connect_books_db()
    try:
        with conn:
            conn.execute("UPDATE books SET archived = ? WHERE book_id = ?", (int(bool(archived)), book_id))
    finally:
        conn.close()


def delete_book(base: Path, book_id: str) -> None:
    path = book_dir(base, book_id)
    if not path.exists():
        path = archive_book_dir(base, book_id)
        if not path.exists():
            _delete_metadata_row(base, book_id)
            return
    shutil.rmtree(path)
    _delete_metadata_row(base, book_id)


def archive_book(base: Path, book_id: str) -> None:
    src = book_dir(base, book_id)
    if not src.exists():
        _set_metadata_archived(base, book_id, True)
        return
    dest = archive_book_dir(base, book_id)
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))
    _set_metadata_archived(base, book_id, True)
