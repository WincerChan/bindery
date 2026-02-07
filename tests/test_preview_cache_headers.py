import asyncio
import os
import tempfile
import unittest
import uuid
from pathlib import Path

from starlette.requests import Request

from bindery.epub import build_epub
from bindery.models import Book, Chapter, Metadata
from bindery.storage import save_book, save_metadata
from bindery.web import epub_item, preview


class PreviewCacheHeadersTests(unittest.TestCase):
    def test_preview_and_epub_item_responses_are_no_store(self) -> None:
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

                preview_request = Request(
                    {
                        "type": "http",
                        "method": "GET",
                        "path": f"/book/{book_id}/preview/0",
                        "query_string": b"",
                        "headers": [],
                    }
                )
                preview_response = asyncio.run(preview(preview_request, book_id, 0))
                self.assertIn("no-store", preview_response.headers.get("cache-control", ""))
                self.assertEqual(preview_response.headers.get("cdn-cache-control"), "no-store")

                item_response = asyncio.run(epub_item(book_id, "section_0001.xhtml"))
                self.assertIn("no-store", item_response.headers.get("cache-control", ""))
                self.assertEqual(item_response.headers.get("cdn-cache-control"), "no-store")
            finally:
                if previous is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = previous


if __name__ == "__main__":
    unittest.main()
