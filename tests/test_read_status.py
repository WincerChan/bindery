import asyncio
import os
import tempfile
import unittest
import uuid
from pathlib import Path

from starlette.requests import Request

from bindery.models import Book, Metadata
from bindery.storage import library_dir, load_metadata, save_book, save_metadata
from bindery.web import _status_view, set_read_status


class ReadStatusTests(unittest.TestCase):
    def test_set_read_status_route_updates_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                book_id = uuid.uuid4().hex
                save_book(Book(title="书", author="作者", intro=None), base, book_id)
                save_metadata(
                    Metadata(
                        book_id=book_id,
                        title="书",
                        author="作者",
                        language="zh-CN",
                        description=None,
                    ),
                    base,
                )

                request = Request({"type": "http", "method": "POST", "headers": []})
                response = asyncio.run(set_read_status(request, book_id, read="1", next="/"))
                self.assertEqual(response.status_code, 303)
                self.assertEqual(response.headers.get("location"), "/")
                updated = load_metadata(base, book_id)
                self.assertTrue(updated.read)
                self.assertIsNotNone(updated.read_updated_at)

                response2 = asyncio.run(set_read_status(request, book_id, read="0", next="/book/x"))
                self.assertEqual(response2.status_code, 303)
                self.assertEqual(response2.headers.get("location"), "/book/x")
                self.assertFalse(load_metadata(base, book_id).read)
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev

    def test_set_read_status_rejects_external_next(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                book_id = uuid.uuid4().hex
                save_book(Book(title="书", author="作者", intro=None), base, book_id)
                save_metadata(
                    Metadata(
                        book_id=book_id,
                        title="书",
                        author="作者",
                        language="zh-CN",
                        description=None,
                    ),
                    base,
                )
                request = Request({"type": "http", "method": "POST", "headers": []})
                response = asyncio.run(set_read_status(request, book_id, read="1", next="https://evil.example"))
                self.assertEqual(response.status_code, 303)
                self.assertEqual(response.headers.get("location"), f"/book/{book_id}")
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev

    def test_set_read_status_does_not_change_writeback_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                book_id = uuid.uuid4().hex
                save_book(Book(title="书", author="作者", intro=None), base, book_id)
                save_metadata(
                    Metadata(
                        book_id=book_id,
                        title="书",
                        author="作者",
                        language="zh-CN",
                        description=None,
                        status="synced",
                        updated_at="2026-02-06T00:00:00+00:00",
                        epub_updated_at="2026-02-06T00:00:00+00:00",
                    ),
                    base,
                )
                request = Request({"type": "http", "method": "POST", "headers": []})

                asyncio.run(set_read_status(request, book_id, read="1", next="/"))

                updated = load_metadata(base, book_id)
                self.assertEqual(updated.updated_at, "2026-02-06T00:00:00+00:00")
                label, status_class = _status_view(updated)
                self.assertEqual(status_class, "ok")
                self.assertEqual(label, "已写回元数据")
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev


if __name__ == "__main__":
    unittest.main()
