import asyncio
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path

from starlette.requests import Request

from bindery.db import get_reader_progress
from bindery.epub import build_epub
from bindery.models import Book, Chapter, Metadata
from bindery.storage import save_book, save_metadata
from bindery.web import preview, save_reader_progress


def _json_request(path: str, payload: dict) -> Request:
    body = json.dumps(payload).encode("utf-8")
    sent = False

    async def receive() -> dict:
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": path,
            "query_string": b"",
            "headers": [(b"content-type", b"application/json")],
        },
        receive,
    )


class ReaderProgressTests(unittest.TestCase):
    def test_progress_endpoint_persists_into_db(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = Path(tmp)
                book_id = uuid.uuid4().hex
                chapter = Chapter(title="第一章", lines=["正文"])
                book = Book(title="测试书", author="作者", intro=None, root_chapters=[chapter], spine=[chapter])
                meta = Metadata(
                    book_id=book_id,
                    title="测试书",
                    author="作者",
                    language="zh-CN",
                    description=None,
                    source_type="epub",
                )
                save_book(book, base, book_id)
                save_metadata(meta, base)
                build_epub(book, meta, base / book_id / "book.epub")

                request = _json_request(
                    f"/book/{book_id}/progress",
                    {"section": 2, "page": 5, "page_count": 12},
                )
                payload = asyncio.run(save_reader_progress(request, book_id))
                self.assertTrue(payload.get("ok"))

                row = get_reader_progress(book_id)
                self.assertIsNotNone(row)
                assert row is not None
                self.assertEqual(row["section"], 2)
                self.assertEqual(row["page"], 5)
                self.assertEqual(row["page_count"], 12)
            finally:
                if previous is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = previous

    def test_preview_context_contains_initial_progress(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = Path(tmp)
                book_id = uuid.uuid4().hex
                chapter = Chapter(title="第一章", lines=["正文"])
                book = Book(title="测试书", author="作者", intro=None, root_chapters=[chapter], spine=[chapter])
                meta = Metadata(
                    book_id=book_id,
                    title="测试书",
                    author="作者",
                    language="zh-CN",
                    description=None,
                    source_type="epub",
                )
                save_book(book, base, book_id)
                save_metadata(meta, base)
                build_epub(book, meta, base / book_id / "book.epub")

                save_request = _json_request(
                    f"/book/{book_id}/progress",
                    {"section": 0, "page": 3, "page_count": 8},
                )
                asyncio.run(save_reader_progress(save_request, book_id))

                preview_request = Request(
                    {
                        "type": "http",
                        "method": "GET",
                        "path": f"/book/{book_id}/preview/0",
                        "query_string": b"",
                        "headers": [],
                    }
                )
                response = asyncio.run(preview(preview_request, book_id, 0))
                initial = response.context.get("initial_progress")
                self.assertIsInstance(initial, dict)
                assert isinstance(initial, dict)
                self.assertEqual(initial.get("section"), 0)
                self.assertEqual(initial.get("page"), 3)
                self.assertEqual(initial.get("page_count"), 8)
            finally:
                if previous is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = previous


if __name__ == "__main__":
    unittest.main()
