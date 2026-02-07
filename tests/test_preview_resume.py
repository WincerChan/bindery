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
from bindery.web import preview_first


class PreviewResumeTests(unittest.TestCase):
    def test_preview_first_redirects_with_resume_flag(self) -> None:
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

                request = Request(
                    {
                        "type": "http",
                        "method": "GET",
                        "path": f"/book/{book_id}/preview",
                        "query_string": b"return_to=%2Fjobs%3Ftab%3Dsuccess",
                        "headers": [],
                    }
                )
                response = asyncio.run(preview_first(request, book_id))
                self.assertEqual(response.status_code, 303)
                location = response.headers.get("location", "")
                self.assertIn("/book/", location)
                self.assertIn("/preview/0?", location)
                self.assertIn("resume=1", location)
                self.assertIn("return_to=%2Fjobs%3Ftab%3Dsuccess", location)
            finally:
                if previous is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = previous


if __name__ == "__main__":
    unittest.main()
