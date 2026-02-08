from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path
from typing import Optional

from .env import read_env
from .models import Job

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
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_book ON jobs(book_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_books_archived ON books(archived)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_books_updated ON books(updated_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reader_progress_updated ON reader_progress(updated_at DESC)")
    conn.close()


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
