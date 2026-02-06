import asyncio
import os
import tempfile
import unittest

from starlette.datastructures import UploadFile
from starlette.requests import Request

from bindery.db import init_db
from bindery.storage import library_dir, list_books
from bindery.web import ingest


class IngestDedupeTests(unittest.TestCase):
    def _make_upload(self, name: str, content: str) -> UploadFile:
        spooled = tempfile.SpooledTemporaryFile(max_size=1024 * 1024)
        spooled.write(content.encode("utf-8"))
        spooled.seek(0)
        return UploadFile(filename=name, file=spooled)

    def test_normalize_mode_reuses_existing_book(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            try:
                init_db()
                request = Request({"type": "http", "method": "POST", "headers": []})
                first_upload = self._make_upload("first.txt", "第一章 起点\n正文")
                response_first = asyncio.run(
                    ingest(
                        request,
                        files=[first_upload],
                        title="重复样例",
                        author="",
                        language="",
                        description="",
                        series="",
                        identifier="",
                        publisher="",
                        tags="",
                        published="",
                        isbn="",
                        rating="",
                        rule_template="default",
                        theme_template="",
                        custom_css="",
                        dedupe_mode="keep",
                        cover_file=None,
                    )
                )
                first_upload.file.close()

                self.assertEqual(getattr(response_first, "status_code", None), 303)
                books_after_first = list_books(library_dir())
                self.assertEqual(len(books_after_first), 1)
                existing_id = books_after_first[0].book_id

                second_upload = self._make_upload("second.txt", "第一章 起点\n正文")
                response_second = asyncio.run(
                    ingest(
                        request,
                        files=[second_upload],
                        title="重复样例",
                        author="",
                        language="",
                        description="",
                        series="",
                        identifier="",
                        publisher="",
                        tags="",
                        published="",
                        isbn="",
                        rating="",
                        rule_template="default",
                        theme_template="",
                        custom_css="",
                        dedupe_mode="normalize",
                        cover_file=None,
                    )
                )
                second_upload.file.close()

                books_after_second = list_books(library_dir())
                self.assertEqual(len(books_after_second), 1)
                self.assertEqual(getattr(response_second, "status_code", None), 303)
                self.assertEqual(response_second.headers.get("location"), f"/book/{existing_id}/edit")
            finally:
                if previous_library is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = previous_library
                if previous_db is None:
                    os.environ.pop("BINDERY_DB_PATH", None)
                else:
                    os.environ["BINDERY_DB_PATH"] = previous_db


if __name__ == "__main__":
    unittest.main()
