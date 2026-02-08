import json
import os
import sqlite3
import tempfile
import unittest

from bindery.db import db_path
from bindery.models import Metadata, metadata_to_dict
from bindery.storage import (
    BOOK_FILE,
    META_FILE,
    archive_book_dir,
    library_dir,
    list_archived_books,
    list_books,
    load_metadata,
    save_metadata,
)


class MetadataSQLiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_library = os.environ.get("BINDERY_LIBRARY_DIR")
        self.old_db = os.environ.get("BINDERY_DB_PATH")
        os.environ["BINDERY_LIBRARY_DIR"] = self.tmp.name
        os.environ.pop("BINDERY_DB_PATH", None)

    def tearDown(self) -> None:
        self.tmp.cleanup()
        if self.old_library is None:
            os.environ.pop("BINDERY_LIBRARY_DIR", None)
        else:
            os.environ["BINDERY_LIBRARY_DIR"] = self.old_library
        if self.old_db is None:
            os.environ.pop("BINDERY_DB_PATH", None)
        else:
            os.environ["BINDERY_DB_PATH"] = self.old_db

    def test_save_metadata_persists_into_sqlite(self) -> None:
        base = library_dir()
        book_id = "a" * 32
        (base / book_id).mkdir(parents=True, exist_ok=True)
        (base / book_id / BOOK_FILE).write_text("{}", encoding="utf-8")
        (base / book_id / META_FILE).write_text("{}", encoding="utf-8")
        meta = Metadata(
            book_id=book_id,
            title="SQLite Book",
            author="Author",
            language="zh-CN",
            description="desc",
            tags=["tag1", "tag2"],
            updated_at="2026-02-08T00:00:00+00:00",
            created_at="2026-02-08T00:00:00+00:00",
        )

        save_metadata(meta, base)

        conn = sqlite3.connect(db_path())
        try:
            row = conn.execute("SELECT title, tags_json FROM books WHERE book_id = ?", (book_id,)).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row)
        self.assertEqual(row[0], "SQLite Book")
        self.assertEqual(json.loads(row[1]), ["tag1", "tag2"])
        self.assertFalse((base / book_id / META_FILE).exists())
        loaded = load_metadata(base, book_id)
        self.assertEqual(loaded.title, "SQLite Book")
        self.assertEqual(loaded.tags, ["tag1", "tag2"])

    def test_legacy_meta_json_migrates_to_sqlite(self) -> None:
        base = library_dir()
        active_id = "b" * 32
        archived_id = "c" * 32

        (base / active_id).mkdir(parents=True, exist_ok=True)
        (base / active_id / BOOK_FILE).write_text("{}", encoding="utf-8")
        active_meta = Metadata(
            book_id=active_id,
            title="Legacy Active",
            author="A",
            language="zh-CN",
            description=None,
            updated_at="2026-02-08T00:00:00+00:00",
            created_at="2026-02-08T00:00:00+00:00",
        )
        (base / active_id / META_FILE).write_text(
            json.dumps(metadata_to_dict(active_meta), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        archived_dir = archive_book_dir(base, archived_id)
        archived_dir.mkdir(parents=True, exist_ok=True)
        archived_meta = Metadata(
            book_id=archived_id,
            title="Legacy Archived",
            author="B",
            language="zh-CN",
            description=None,
            archived=True,
            updated_at="2026-02-08T00:00:00+00:00",
            created_at="2026-02-08T00:00:00+00:00",
        )
        (archived_dir / META_FILE).write_text(
            json.dumps(metadata_to_dict(archived_meta), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        active_books = list_books(base)
        archived_books = list_archived_books(base)

        self.assertEqual([book.book_id for book in active_books], [active_id])
        self.assertEqual([book.book_id for book in archived_books], [archived_id])
        self.assertFalse((base / active_id / META_FILE).exists())
        self.assertFalse((archived_dir / META_FILE).exists())

        conn = sqlite3.connect(db_path())
        try:
            rows = conn.execute("SELECT book_id, archived FROM books ORDER BY book_id").fetchall()
        finally:
            conn.close()
        self.assertEqual(rows, [(active_id, 0), (archived_id, 1)])


if __name__ == "__main__":
    unittest.main()
