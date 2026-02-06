import asyncio
import os
import tempfile
import unittest
import zipfile
from io import BytesIO

from fastapi import HTTPException

from bindery.epub import build_epub
from bindery.models import Book, Metadata
from bindery.storage import library_dir, list_archived_books, list_books, save_book, save_metadata
from bindery.web import archive_bulk, download_bulk


class BulkActionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_library_dir = os.environ.get("BINDERY_LIBRARY_DIR")
        os.environ["BINDERY_LIBRARY_DIR"] = self.tmp.name

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


if __name__ == "__main__":
    unittest.main()
