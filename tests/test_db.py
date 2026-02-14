import os
import tempfile
import unittest
from pathlib import Path

import bindery.db as db_module
from bindery.db import (
    create_wish,
    create_job,
    db_path,
    delete_wish,
    delete_jobs,
    get_job,
    get_reader_progress,
    get_wish,
    get_wish_by_library_book_id,
    init_db,
    list_wishes,
    list_jobs,
    update_wish,
    upsert_reader_progress,
)
from bindery.models import Job, Wish


class DbTests(unittest.TestCase):
    def test_jobs_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "bindery.db")
            os.environ["BINDERY_DB_PATH"] = db_path
            try:
                init_db()
                job = Job(
                    id="job1",
                    book_id="book1",
                    action="upload",
                    status="running",
                    stage="预处理",
                    message=None,
                    log=None,
                    rule_template="default",
                    created_at="now",
                    updated_at="now",
                )
                create_job(job)
                fetched = get_job("job1")
                self.assertIsNotNone(fetched)
                self.assertEqual(fetched.book_id, "book1")
                self.assertEqual(len(list_jobs()), 1)
            finally:
                del os.environ["BINDERY_DB_PATH"]

    def test_delete_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "bindery.db")
            os.environ["BINDERY_DB_PATH"] = db_path
            try:
                init_db()
                job1 = Job(
                    id="job1",
                    book_id="book1",
                    action="upload",
                    status="running",
                    stage="预处理",
                    message=None,
                    log=None,
                    rule_template="default",
                    created_at="now",
                    updated_at="now",
                )
                job2 = Job(
                    id="job2",
                    book_id="book2",
                    action="upload",
                    status="running",
                    stage="预处理",
                    message=None,
                    log=None,
                    rule_template="default",
                    created_at="now",
                    updated_at="now",
                )
                create_job(job1)
                create_job(job2)
                deleted = delete_jobs(["job1", "missing-id"])
                self.assertEqual(deleted, 1)
                remaining = list_jobs()
                self.assertEqual(len(remaining), 1)
                self.assertEqual(remaining[0].id, "job2")
            finally:
                del os.environ["BINDERY_DB_PATH"]

    def test_default_db_path_uses_library_dir(self) -> None:
        previous_db = os.environ.get("BINDERY_DB_PATH")
        previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
        with tempfile.TemporaryDirectory() as tmp_library:
            os.environ.pop("BINDERY_DB_PATH", None)
            os.environ["BINDERY_LIBRARY_DIR"] = tmp_library
            try:
                self.assertEqual(db_path(), Path(tmp_library) / "bindery.db")
            finally:
                if previous_db is None:
                    os.environ.pop("BINDERY_DB_PATH", None)
                else:
                    os.environ["BINDERY_DB_PATH"] = previous_db
                if previous_library is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = previous_library

    def test_reader_progress_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_file = os.path.join(tmp, "bindery.db")
            os.environ["BINDERY_DB_PATH"] = db_file
            try:
                init_db()
                self.assertIsNone(get_reader_progress("book-1"))
                upsert_reader_progress("book-1", 3, 7, 12, "2026-02-08T00:00:00+00:00")
                row = get_reader_progress("book-1")
                self.assertIsNotNone(row)
                assert row is not None
                self.assertEqual(row["section"], 3)
                self.assertEqual(row["page"], 7)
                self.assertEqual(row["page_count"], 12)

                upsert_reader_progress("book-1", 4, 1, 20, "2026-02-09T00:00:00+00:00")
                updated = get_reader_progress("book-1")
                self.assertIsNotNone(updated)
                assert updated is not None
                self.assertEqual(updated["section"], 4)
                self.assertEqual(updated["page"], 1)
                self.assertEqual(updated["page_count"], 20)
            finally:
                del os.environ["BINDERY_DB_PATH"]

    def test_db_path_migrates_legacy_db_to_library(self) -> None:
        previous_db = os.environ.get("BINDERY_DB_PATH")
        previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
        original_base_dir = db_module.BASE_DIR
        with tempfile.TemporaryDirectory() as tmp_project, tempfile.TemporaryDirectory() as tmp_library:
            os.environ.pop("BINDERY_DB_PATH", None)
            os.environ["BINDERY_LIBRARY_DIR"] = tmp_library
            db_module.BASE_DIR = Path(tmp_project)
            legacy = Path(tmp_project) / "bindery.db"
            legacy.write_bytes(b"legacy-db")
            try:
                target = db_path()
                self.assertEqual(target, Path(tmp_library) / "bindery.db")
                self.assertTrue(target.exists())
                self.assertFalse(legacy.exists())
                self.assertEqual(target.read_bytes(), b"legacy-db")
            finally:
                db_module.BASE_DIR = original_base_dir
                if previous_db is None:
                    os.environ.pop("BINDERY_DB_PATH", None)
                else:
                    os.environ["BINDERY_DB_PATH"] = previous_db
                if previous_library is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = previous_library

    def test_wishlist_crud(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_file = os.path.join(tmp, "bindery.db")
            os.environ["BINDERY_DB_PATH"] = db_file
            try:
                init_db()
                wish = Wish(
                    id="a" * 32,
                    title="诡秘之主",
                    library_book_id="b" * 32,
                    author="爱潜水的乌贼",
                    rating=5,
                    read=False,
                    read_status="reading",
                    tags=["克苏鲁", "蒸汽朋克"],
                    comment="线索回收扎实",
                    book_status="ongoing",
                    created_at="2026-02-14T00:00:00+00:00",
                    updated_at="2026-02-14T00:00:00+00:00",
                )
                create_wish(wish)
                fetched = get_wish(wish.id)
                self.assertIsNotNone(fetched)
                assert fetched is not None
                self.assertEqual(fetched.title, "诡秘之主")
                self.assertEqual(fetched.library_book_id, "b" * 32)
                self.assertFalse(fetched.read)
                self.assertEqual(fetched.read_status, "reading")
                self.assertEqual(fetched.tags, ["克苏鲁", "蒸汽朋克"])
                self.assertEqual(fetched.comment, "线索回收扎实")
                by_book_id = get_wish_by_library_book_id("b" * 32)
                self.assertIsNotNone(by_book_id)
                assert by_book_id is not None
                self.assertEqual(by_book_id.id, wish.id)

                update_wish(
                    wish.id,
                    title="诡秘之主2",
                    library_book_id="c" * 32,
                    tags=["重读"],
                    rating=None,
                    comment="期待新角色",
                    read_status="read",
                    book_status="completed",
                    updated_at="2026-02-15T00:00:00+00:00",
                )
                updated = get_wish(wish.id)
                self.assertIsNotNone(updated)
                assert updated is not None
                self.assertEqual(updated.title, "诡秘之主2")
                self.assertIsNone(updated.rating)
                self.assertEqual(updated.library_book_id, "c" * 32)
                self.assertTrue(updated.read)
                self.assertEqual(updated.read_status, "read")
                self.assertEqual(updated.tags, ["重读"])
                self.assertEqual(updated.comment, "期待新角色")
                self.assertEqual(updated.book_status, "completed")

                self.assertEqual(len(list_wishes()), 1)
                delete_wish(wish.id)
                self.assertIsNone(get_wish(wish.id))
                self.assertEqual(len(list_wishes()), 0)
            finally:
                del os.environ["BINDERY_DB_PATH"]


if __name__ == "__main__":
    unittest.main()
