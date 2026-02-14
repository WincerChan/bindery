from __future__ import annotations

import json
import re
import shutil
import sqlite3
from pathlib import Path
from typing import Optional

from .env import read_env
from .models import Job, Wish

BASE_DIR = Path(__file__).resolve().parent.parent
DB_FILENAME = "bindery.db"


def _default_library_dir() -> Path:
    env = read_env("BINDERY_LIBRARY_DIR")
    base = Path(env) if env else BASE_DIR / "library"
    base.mkdir(parents=True, exist_ok=True)
    return base


def db_path() -> Path:
    env = read_env("BINDERY_DB_PATH")
    if env:
        return Path(env)
    default_path = _default_library_dir() / DB_FILENAME
    _migrate_legacy_db(default_path)
    return default_path


def _migrate_legacy_db(target: Path) -> None:
    legacy_path = BASE_DIR / DB_FILENAME
    if target == legacy_path:
        return
    if target.exists() or not legacy_path.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        legacy_path.replace(target)
    except OSError:
        try:
            shutil.copy2(legacy_path, target)
            legacy_path.unlink(missing_ok=True)
        except OSError:
            return


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = connect()
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                last_seen TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                book_id TEXT,
                action TEXT NOT NULL,
                status TEXT NOT NULL,
                stage TEXT,
                message TEXT,
                log TEXT,
                rule_template TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reader_progress (
                book_id TEXT PRIMARY KEY,
                section INTEGER NOT NULL,
                page INTEGER NOT NULL,
                page_count INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS wishlist (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                library_book_id TEXT,
                author TEXT,
                identity_title TEXT NOT NULL DEFAULT '',
                identity_author TEXT NOT NULL DEFAULT '',
                rating INTEGER,
                read INTEGER NOT NULL DEFAULT 0,
                read_status TEXT NOT NULL DEFAULT 'unread',
                tags_json TEXT NOT NULL DEFAULT '[]',
                comment TEXT,
                book_status TEXT NOT NULL DEFAULT 'ongoing',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        _ensure_wishlist_columns(conn)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_book ON jobs(book_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_books_archived ON books(archived)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_books_updated ON books(updated_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reader_progress_updated ON reader_progress(updated_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_wishlist_updated ON wishlist(updated_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_wishlist_library_book ON wishlist(library_book_id)")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_library_book_unique ON wishlist(library_book_id) WHERE library_book_id IS NOT NULL"
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_manual_identity_unique
            ON wishlist(identity_title, identity_author)
            WHERE library_book_id IS NULL AND identity_title != ''
            """
        )
    conn.close()


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {str(row["name"]) for row in rows}


def _normalize_identity_text(value: Optional[str]) -> str:
    cleaned = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", (value or "").strip().lower())
    return cleaned


def _wish_identity_pair(title: Optional[str], author: Optional[str]) -> tuple[str, str]:
    return _normalize_identity_text(title), _normalize_identity_text(author)


def _ensure_wishlist_columns(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "wishlist")
    if "library_book_id" not in columns:
        conn.execute("ALTER TABLE wishlist ADD COLUMN library_book_id TEXT")
    if "identity_title" not in columns:
        conn.execute("ALTER TABLE wishlist ADD COLUMN identity_title TEXT NOT NULL DEFAULT ''")
    if "identity_author" not in columns:
        conn.execute("ALTER TABLE wishlist ADD COLUMN identity_author TEXT NOT NULL DEFAULT ''")
    if "read_status" not in columns:
        conn.execute("ALTER TABLE wishlist ADD COLUMN read_status TEXT NOT NULL DEFAULT 'unread'")
    if "tags_json" not in columns:
        conn.execute("ALTER TABLE wishlist ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'")
    if "comment" not in columns:
        conn.execute("ALTER TABLE wishlist ADD COLUMN comment TEXT")
    conn.execute("UPDATE wishlist SET library_book_id = NULL WHERE trim(coalesce(library_book_id, '')) = ''")
    _refresh_wishlist_identity(conn)
    _dedupe_wishlist_library_book(conn)
    _dedupe_wishlist_manual_identity(conn)


def _refresh_wishlist_identity(conn: sqlite3.Connection) -> None:
    rows = conn.execute("SELECT id, title, author FROM wishlist").fetchall()
    updates: list[tuple[str, str, str]] = []
    for row in rows:
        identity_title, identity_author = _wish_identity_pair(row["title"], row["author"])
        updates.append((identity_title, identity_author, str(row["id"])))
    if not updates:
        return
    conn.executemany("UPDATE wishlist SET identity_title = ?, identity_author = ? WHERE id = ?", updates)


def _dedupe_wishlist_library_book(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT id, library_book_id
        FROM wishlist
        WHERE library_book_id IS NOT NULL AND library_book_id != ''
        ORDER BY updated_at DESC, created_at DESC, id DESC
        """
    ).fetchall()
    seen: set[str] = set()
    remove_ids: list[str] = []
    for row in rows:
        library_book_id = str(row["library_book_id"])
        if library_book_id in seen:
            remove_ids.append(str(row["id"]))
            continue
        seen.add(library_book_id)
    if not remove_ids:
        return
    placeholders = ", ".join("?" for _ in remove_ids)
    conn.execute(f"DELETE FROM wishlist WHERE id IN ({placeholders})", remove_ids)


def _dedupe_wishlist_manual_identity(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT id, identity_title, identity_author
        FROM wishlist
        WHERE library_book_id IS NULL AND identity_title != ''
        ORDER BY updated_at DESC, created_at DESC, id DESC
        """
    ).fetchall()
    seen: set[tuple[str, str]] = set()
    remove_ids: list[str] = []
    for row in rows:
        key = (str(row["identity_title"]), str(row["identity_author"]))
        if key in seen:
            remove_ids.append(str(row["id"]))
            continue
        seen.add(key)
    if not remove_ids:
        return
    placeholders = ", ".join("?" for _ in remove_ids)
    conn.execute(f"DELETE FROM wishlist WHERE id IN ({placeholders})", remove_ids)


def create_session(session_id: str, created_at: str) -> None:
    conn = connect()
    with conn:
        conn.execute(
            "INSERT INTO sessions(session_id, created_at, last_seen) VALUES (?, ?, ?)",
            (session_id, created_at, created_at),
        )
    conn.close()


def touch_session(session_id: str, now: str) -> None:
    conn = connect()
    with conn:
        conn.execute("UPDATE sessions SET last_seen = ? WHERE session_id = ?", (now, session_id))
    conn.close()


def delete_session(session_id: str) -> None:
    conn = connect()
    with conn:
        conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
    conn.close()


def get_session(session_id: str) -> Optional[dict]:
    conn = connect()
    row = conn.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def create_job(job: Job) -> None:
    conn = connect()
    with conn:
        conn.execute(
            """
            INSERT INTO jobs(id, book_id, action, status, stage, message, log, rule_template, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job.id,
                job.book_id,
                job.action,
                job.status,
                job.stage,
                job.message,
                job.log,
                job.rule_template,
                job.created_at,
                job.updated_at,
            ),
        )
    conn.close()


def update_job(job_id: str, **fields: object) -> None:
    if not fields:
        return
    columns = ", ".join(f"{key} = ?" for key in fields)
    values = list(fields.values())
    values.append(job_id)
    conn = connect()
    with conn:
        conn.execute(f"UPDATE jobs SET {columns} WHERE id = ?", values)
    conn.close()


def get_job(job_id: str) -> Optional[Job]:
    conn = connect()
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    conn.close()
    return _row_to_job(row) if row else None


def list_jobs(status: Optional[str] = None) -> list[Job]:
    conn = connect()
    if status:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC", (status,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchall()
    conn.close()
    return [_row_to_job(row) for row in rows]


def delete_jobs(job_ids: list[str]) -> int:
    if not job_ids:
        return 0
    placeholders = ", ".join("?" for _ in job_ids)
    conn = connect()
    with conn:
        cursor = conn.execute(f"DELETE FROM jobs WHERE id IN ({placeholders})", job_ids)
    conn.close()
    return cursor.rowcount or 0


def upsert_reader_progress(book_id: str, section: int, page: int, page_count: int, updated_at: str) -> None:
    conn = connect()
    with conn:
        conn.execute(
            """
            INSERT INTO reader_progress(book_id, section, page, page_count, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(book_id) DO UPDATE SET
                section=excluded.section,
                page=excluded.page,
                page_count=excluded.page_count,
                updated_at=excluded.updated_at
            """,
            (book_id, section, page, page_count, updated_at),
        )
    conn.close()


def get_reader_progress(book_id: str) -> Optional[dict]:
    conn = connect()
    row = conn.execute(
        "SELECT book_id, section, page, page_count, updated_at FROM reader_progress WHERE book_id = ?",
        (book_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def create_wish(wish: Wish) -> None:
    library_book_id = (wish.library_book_id or "").strip().lower() or None
    identity_title, identity_author = _wish_identity_pair(wish.title, wish.author)
    conn = connect()
    with conn:
        conn.execute(
            """
            INSERT INTO wishlist(
                id, title, library_book_id, author, identity_title, identity_author, rating, read, read_status, tags_json, comment, book_status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                wish.id,
                wish.title,
                library_book_id,
                wish.author,
                identity_title,
                identity_author,
                wish.rating,
                int(bool(wish.read)),
                wish.read_status,
                json.dumps(list(wish.tags), ensure_ascii=False),
                wish.comment,
                wish.book_status,
                wish.created_at,
                wish.updated_at,
            ),
        )
    conn.close()


def get_wish(wish_id: str) -> Optional[Wish]:
    conn = connect()
    row = conn.execute("SELECT * FROM wishlist WHERE id = ?", (wish_id,)).fetchone()
    conn.close()
    return _row_to_wish(row) if row else None


def get_wish_by_library_book_id(book_id: str) -> Optional[Wish]:
    conn = connect()
    row = conn.execute(
        "SELECT * FROM wishlist WHERE library_book_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1",
        (book_id,),
    ).fetchone()
    conn.close()
    return _row_to_wish(row) if row else None


def get_manual_wish_by_identity(title: str, author: Optional[str], *, exclude_id: Optional[str] = None) -> Optional[Wish]:
    identity_title, identity_author = _wish_identity_pair(title, author)
    if not identity_title:
        return None
    query = """
        SELECT *
        FROM wishlist
        WHERE library_book_id IS NULL AND identity_title = ? AND identity_author = ?
    """
    params: list[object] = [identity_title, identity_author]
    safe_exclude = (exclude_id or "").strip()
    if safe_exclude:
        query += " AND id != ?"
        params.append(safe_exclude)
    query += " ORDER BY updated_at DESC, created_at DESC LIMIT 1"
    conn = connect()
    row = conn.execute(query, params).fetchone()
    conn.close()
    return _row_to_wish(row) if row else None


def list_wishes() -> list[Wish]:
    conn = connect()
    rows = conn.execute("SELECT * FROM wishlist ORDER BY updated_at DESC, created_at DESC").fetchall()
    conn.close()
    return [_row_to_wish(row) for row in rows]


def update_wish(wish_id: str, **fields: object) -> None:
    if not fields:
        return
    if "tags" in fields:
        raw_tags = fields.pop("tags")
        tags = raw_tags if isinstance(raw_tags, list) else []
        fields["tags_json"] = json.dumps([str(tag) for tag in tags if str(tag).strip()], ensure_ascii=False)
    if "read" in fields:
        fields["read"] = int(bool(fields["read"]))
    if "library_book_id" in fields:
        raw_book_id = fields["library_book_id"]
        if isinstance(raw_book_id, str):
            fields["library_book_id"] = raw_book_id.strip().lower() or None
        elif raw_book_id is None:
            fields["library_book_id"] = None
        else:
            fields["library_book_id"] = None
    if "title" in fields or "author" in fields:
        current = get_wish(wish_id)
        title_value = fields["title"] if "title" in fields else (current.title if current is not None else "")
        author_value = fields["author"] if "author" in fields else (current.author if current is not None else None)
        title_text = title_value if isinstance(title_value, str) else str(title_value or "")
        if author_value is None:
            author_text: Optional[str] = None
        elif isinstance(author_value, str):
            author_text = author_value
        else:
            author_text = str(author_value)
        identity_title, identity_author = _wish_identity_pair(title_text, author_text)
        fields["identity_title"] = identity_title
        fields["identity_author"] = identity_author
    if "read_status" in fields and "read" not in fields:
        fields["read"] = int(str(fields["read_status"]).strip().lower() == "read")
    columns = ", ".join(f"{key} = ?" for key in fields)
    values = list(fields.values())
    values.append(wish_id)
    conn = connect()
    with conn:
        conn.execute(f"UPDATE wishlist SET {columns} WHERE id = ?", values)
    conn.close()


def delete_wish(wish_id: str) -> None:
    conn = connect()
    with conn:
        conn.execute("DELETE FROM wishlist WHERE id = ?", (wish_id,))
    conn.close()


def _row_to_job(row: sqlite3.Row) -> Job:
    return Job(
        id=row["id"],
        book_id=row["book_id"],
        action=row["action"],
        status=row["status"],
        stage=row["stage"],
        message=row["message"],
        log=row["log"],
        rule_template=row["rule_template"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_wish(row: sqlite3.Row) -> Wish:
    raw_tags = row["tags_json"] if "tags_json" in row.keys() else "[]"
    try:
        parsed_tags = json.loads(raw_tags or "[]")
        tags = parsed_tags if isinstance(parsed_tags, list) else []
    except json.JSONDecodeError:
        tags = []
    read_status = "unread"
    if "read_status" in row.keys() and row["read_status"]:
        read_status = str(row["read_status"]).strip().lower()
    if read_status not in {"unread", "reading", "read"}:
        read_status = "read" if bool(row["read"]) else "unread"
    return Wish(
        id=row["id"],
        title=row["title"] or "",
        library_book_id=row["library_book_id"] if "library_book_id" in row.keys() else None,
        author=row["author"],
        rating=row["rating"],
        read=bool(row["read"]),
        read_status=read_status,
        tags=[str(item) for item in tags if str(item).strip()],
        comment=row["comment"] if "comment" in row.keys() else None,
        book_status=row["book_status"] or "ongoing",
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
