import asyncio
import os
import tempfile
import unittest

from bindery.models import Book, Metadata
from bindery.storage import epub_path, library_dir, save_book, save_metadata
from bindery.web import download


class DownloadFilenameTests(unittest.TestCase):
    def test_download_filename_uses_title_and_author(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                book_id = "a" * 32

                book = Book(title="乱世书", author="姬叉", intro=None)
                meta = Metadata(
                    book_id=book_id,
                    title="乱世书",
                    author="姬叉",
                    language="zh-CN",
                    description=None,
                    created_at="",
                    updated_at="",
                )

                save_book(book, base, book_id)
                save_metadata(meta, base)
                epub_path(base, book_id).write_bytes(b"dummy")

                resp = asyncio.run(download(book_id))
                self.assertEqual(resp.filename, "乱世书-姬叉.epub")
            finally:
                if old is None:
                    del os.environ["BINDERY_LIBRARY_DIR"]
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = old

    def test_download_filename_uses_unknown_when_author_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                book_id = "b" * 32

                book = Book(title="乱世书", author=None, intro=None)
                meta = Metadata(
                    book_id=book_id,
                    title="乱世书",
                    author=None,
                    language="zh-CN",
                    description=None,
                    created_at="",
                    updated_at="",
                )

                save_book(book, base, book_id)
                save_metadata(meta, base)
                epub_path(base, book_id).write_bytes(b"dummy")

                resp = asyncio.run(download(book_id))
                self.assertEqual(resp.filename, "乱世书-未知.epub")
            finally:
                if old is None:
                    del os.environ["BINDERY_LIBRARY_DIR"]
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = old


if __name__ == "__main__":
    unittest.main()
