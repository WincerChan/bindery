import base64
import os
import tempfile
import unittest
import uuid
from pathlib import Path

import asyncio
from unittest.mock import patch

from starlette.datastructures import UploadFile
from starlette.requests import Request

from bindery.db import init_db, list_jobs
from bindery.epub import build_epub, extract_cover
from bindery.models import Book, Chapter, Metadata
from bindery.storage import cover_path, epub_path, load_metadata, save_book, save_metadata
from bindery.web import _process_queued_ingest_task, save_edit


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X4D1kAAAAASUVORK5CYII="
)


class CoverEditTests(unittest.TestCase):
    def test_edit_can_write_cover_into_epub(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = Path(tmp)
                book_id = uuid.uuid4().hex
                init_db()

                chap = Chapter(title="第一章", lines=["hello"])
                book = Book(title="示例书", author=None, intro=None, root_chapters=[chap], spine=[chap])
                meta = Metadata(
                    book_id=book_id,
                    title="示例书",
                    author="作者",
                    language="zh-CN",
                    description=None,
                    source_type="epub",
                )
                save_book(book, base, book_id)
                save_metadata(meta, base)

                epub_file = epub_path(base, book_id)
                build_epub(book, meta, epub_file)

                request = Request({"type": "http", "method": "POST", "headers": []})
                with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as spooled:
                    spooled.write(PNG_1X1)
                    spooled.seek(0)
                    upload = UploadFile(filename="cover.png", file=spooled)
                    queued_tasks: list[dict] = []
                    with (
                        patch("bindery.web._ensure_ingest_worker_started"),
                        patch("bindery.web._enqueue_ingest_task", side_effect=lambda task: queued_tasks.append(task) or True),
                    ):
                        response = asyncio.run(
                            save_edit(
                                request,
                                book_id,
                                title="示例书",
                                author="作者",
                                language="zh-CN",
                                description="",
                                series="",
                                identifier=None,
                                publisher="",
                                tags="",
                                published="",
                                isbn="",
                                rating="",
                                rule_template="",
                                theme_template="",
                                custom_css="",
                                cover_file=upload,
                                cover_url="",
                            )
                        )
                    self.assertEqual(response.status_code, 303)
                    self.assertEqual(response.headers.get("location"), "/jobs?tab=running")
                    self.assertEqual(len(queued_tasks), 1)
                    jobs = list_jobs()
                    self.assertEqual(len(jobs), 1)
                    self.assertEqual(jobs[0].action, "edit-writeback")
                    _process_queued_ingest_task(queued_tasks[0])

                jobs = list_jobs()
                self.assertEqual(jobs[0].status, "success")

                extracted = extract_cover(epub_file)
                self.assertIsNotNone(extracted)
                cover_bytes, _ = extracted  # type: ignore[misc]
                self.assertEqual(cover_bytes, PNG_1X1)

                meta2 = load_metadata(base, book_id)
                self.assertEqual(meta2.status, "synced")
                self.assertTrue(meta2.cover_file)
                self.assertTrue(cover_path(base, book_id, meta2.cover_file or "").exists())
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev


if __name__ == "__main__":
    unittest.main()
