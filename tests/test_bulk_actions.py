import asyncio
import os
import tempfile
import unittest
import zipfile
from io import BytesIO
from unittest.mock import patch

from fastapi import HTTPException

from bindery.db import init_db, list_jobs
from bindery.epub import build_epub
from bindery.models import Book, Metadata
from bindery.storage import library_dir, list_archived_books, list_books, save_book, save_metadata
from bindery.web import KEEP_BOOK_THEME_ID, archive_bulk, archive_delete_bulk, download_bulk, regenerate_bulk


class BulkActionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_library_dir = os.environ.get("BINDERY_LIBRARY_DIR")
        os.environ["BINDERY_LIBRARY_DIR"] = self.tmp.name
        init_db()

    def tearDown(self) -> None:
        self.tmp.cleanup()
        if self.old_library_dir is None:
            del os.environ["BINDERY_LIBRARY_DIR"]
        else:
            os.environ["BINDERY_LIBRARY_DIR"] = self.old_library_dir

    def _create_book(self, book_id: str, title: str, author: str) -> None:
        base = library_dir()
        book = Book(title=title, author=author, intro=None)
        meta = Metadata(
            book_id=book_id,
            title=title,
            author=author,
            language="zh-CN",
            description=None,
            created_at="",
            updated_at="",
        )
        save_book(book, base, book_id)
        save_metadata(meta, base)
        build_epub(book, meta, base / book_id / "book.epub")

    def _create_book_with_meta(self, meta: Metadata) -> None:
        base = library_dir()
        save_book(Book(title=meta.title, author=meta.author, intro=meta.description), base, meta.book_id)
        save_metadata(meta, base)

    def test_archive_bulk_archives_only_valid_existing_books(self) -> None:
        self._create_book("a" * 32, "Book A", "Author")
        self._create_book("b" * 32, "Book B", "Author")

        response = asyncio.run(archive_bulk(["a" * 32, "bad-id", "b" * 32, "a" * 32]))

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/")
        self.assertEqual(len(list_books(library_dir())), 0)
        archived_ids = {meta.book_id for meta in list_archived_books(library_dir())}
        self.assertEqual(archived_ids, {"a" * 32, "b" * 32})

    def test_download_bulk_returns_zip_with_unique_names(self) -> None:
        self._create_book("a" * 32, "Same", "Author")
        self._create_book("b" * 32, "Same", "Author")

        response = asyncio.run(download_bulk(["a" * 32, "b" * 32]))

        self.assertEqual(response.media_type, "application/zip")
        content_disposition = response.headers.get("content-disposition", "")
        self.assertIn("bindery-books-", content_disposition)
        self.assertIn(".zip", content_disposition)

        with zipfile.ZipFile(BytesIO(response.body), "r") as archive:
            names = archive.namelist()
        self.assertEqual(len(names), 2)
        self.assertEqual(len(set(names)), 2)
        for name in names:
            self.assertTrue(name.endswith(".epub"))

    def test_download_bulk_rejects_empty_selection(self) -> None:
        with self.assertRaises(HTTPException) as exc:
            asyncio.run(download_bulk([]))
        self.assertEqual(exc.exception.status_code, 400)

    def test_archive_delete_bulk_removes_only_archived_books(self) -> None:
        self._create_book("a" * 32, "Book A", "Author")
        self._create_book("b" * 32, "Book B", "Author")
        self._create_book("c" * 32, "Book C", "Author")

        asyncio.run(archive_bulk(["a" * 32, "b" * 32]))
        response = asyncio.run(archive_delete_bulk(["a" * 32, "c" * 32, "bad-id"]))

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/archive")
        active_ids = {meta.book_id for meta in list_books(library_dir())}
        archived_ids = {meta.book_id for meta in list_archived_books(library_dir())}
        self.assertIn("c" * 32, active_ids)
        self.assertNotIn("a" * 32, active_ids)
        self.assertIn("b" * 32, archived_ids)
        self.assertNotIn("a" * 32, archived_ids)

    def test_regenerate_bulk_for_rule_queues_matching_txt_books_only(self) -> None:
        self._create_book_with_meta(
            Metadata(
                book_id="a" * 32,
                title="Book A",
                author="Author A",
                language="zh-CN",
                description=None,
                source_type="txt",
                rule_template="default",
            )
        )
        self._create_book_with_meta(
            Metadata(
                book_id="b" * 32,
                title="Book B",
                author="Author B",
                language="zh-CN",
                description=None,
                source_type="txt",
                rule_template="webnovel",
            )
        )
        self._create_book_with_meta(
            Metadata(
                book_id="c" * 32,
                title="Book C",
                author="Author C",
                language="zh-CN",
                description=None,
                source_type="epub",
                rule_template="default",
            )
        )

        queued: list[dict] = []
        with (
            patch("bindery.web._ensure_ingest_worker_started"),
            patch("bindery.web._ingest_queue.put", side_effect=lambda task: queued.append(task)),
        ):
            response = asyncio.run(regenerate_bulk(scope="parsing", template_id="default"))

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/jobs?tab=running")
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0].get("kind"), "regenerate")
        self.assertEqual(queued[0].get("book_id"), "a" * 32)
        jobs = list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].action, "regenerate")
        self.assertEqual(jobs[0].book_id, "a" * 32)

    def test_regenerate_bulk_for_theme_queues_txt_and_epub_writeback(self) -> None:
        self._create_book_with_meta(
            Metadata(
                book_id="a" * 32,
                title="Book A",
                author="Author A",
                language="zh-CN",
                description=None,
                source_type="txt",
                theme_template="default",
                rule_template="default",
            )
        )
        self._create_book_with_meta(
            Metadata(
                book_id="b" * 32,
                title="Book B",
                author="Author B",
                language="zh-CN",
                description=None,
                source_type="epub",
                theme_template="default",
            )
        )
        self._create_book_with_meta(
            Metadata(
                book_id="c" * 32,
                title="Book C",
                author="Author C",
                language="zh-CN",
                description=None,
                source_type="epub",
                theme_template=KEEP_BOOK_THEME_ID,
            )
        )

        queued: list[dict] = []
        with (
            patch("bindery.web._ensure_ingest_worker_started"),
            patch("bindery.web._ingest_queue.put", side_effect=lambda task: queued.append(task)),
        ):
            response = asyncio.run(regenerate_bulk(scope="themes", template_id="default"))

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/jobs?tab=running")
        self.assertEqual(len(queued), 2)
        queued_kinds = {str(task.get("kind")) for task in queued}
        self.assertEqual(queued_kinds, {"regenerate", "edit-writeback"})
        queued_ids = {str(task.get("book_id")) for task in queued}
        self.assertEqual(queued_ids, {"a" * 32, "b" * 32})
        jobs = list_jobs()
        self.assertEqual(len(jobs), 2)
        actions = {job.action for job in jobs}
        self.assertEqual(actions, {"regenerate", "edit-writeback"})


if __name__ == "__main__":
    unittest.main()
