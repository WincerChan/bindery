import asyncio
import os
import queue
import tempfile
import unittest
from unittest.mock import patch

from starlette.datastructures import UploadFile
from starlette.requests import Request

from bindery.db import init_db
from bindery.db import list_jobs
from bindery.web import ingest
import bindery.web as web_module


class IngestRedirectTests(unittest.TestCase):
    def _drain_queue(self) -> None:
        while True:
            try:
                web_module._ingest_queue.get_nowait()
                web_module._ingest_queue.task_done()
            except queue.Empty:
                break

    def test_single_ingest_redirects_to_jobs_and_queues_task(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            try:
                init_db()
                request = Request({"type": "http", "method": "POST", "headers": []})
                with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as spooled:
                    spooled.write("第一章 开始\n正文".encode("utf-8"))
                    spooled.seek(0)
                    upload = UploadFile(filename="sample.txt", file=spooled)
                    with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
                        response = asyncio.run(
                            ingest(
                                request,
                                files=[upload],
                                title="",
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

                self.assertEqual(getattr(response, "status_code", None), 303)
                self.assertEqual(response.headers.get("location", ""), "/jobs")
                jobs = list_jobs()
                self.assertEqual(len(jobs), 1)
                self.assertEqual(jobs[0].status, "running")
                self.assertEqual(jobs[0].stage, "排队中")
            finally:
                self._drain_queue()
                if previous_library is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = previous_library
                if previous_db is None:
                    os.environ.pop("BINDERY_DB_PATH", None)
                else:
                    os.environ["BINDERY_DB_PATH"] = previous_db

    def test_large_batch_ingest_redirects_to_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            try:
                init_db()
                request = Request({"type": "http", "method": "POST", "headers": []})
                with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as spooled_one:
                    with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as spooled_two:
                        spooled_one.write("第一章 开始\n正文".encode("utf-8"))
                        spooled_two.write("第一章 第二本\n正文".encode("utf-8"))
                        spooled_one.seek(0)
                        spooled_two.seek(0)
                        upload_one = UploadFile(filename="sample-1.txt", file=spooled_one)
                        upload_two = UploadFile(filename="sample-2.txt", file=spooled_two)
                        with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
                            response = asyncio.run(
                                ingest(
                                    request,
                                    files=[upload_one, upload_two],
                                    title="",
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

                self.assertEqual(getattr(response, "status_code", None), 303)
                self.assertEqual(response.headers.get("location", ""), "/jobs")
                self.assertEqual(len(list_jobs()), 2)
            finally:
                self._drain_queue()
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
