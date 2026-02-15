import asyncio
import os
import queue
import tempfile
import unittest
from pathlib import Path
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

    def test_single_ingest_stays_on_ingest_and_queues_task(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            previous_stage = os.environ.get("BINDERY_STAGE_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            os.environ["BINDERY_STAGE_DIR"] = os.path.join(tmp, ".ingest-stage")
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
                location = response.headers.get("location", "")
                self.assertTrue(location.startswith("/ingest?"))
                self.assertIn("toast=", location)
                self.assertIn("toast_kind=success", location)
                jobs = list_jobs()
                self.assertEqual(len(jobs), 1)
                self.assertEqual(jobs[0].status, "running")
                self.assertEqual(jobs[0].stage, "排队中")
                queued_task = web_module._ingest_queue.get_nowait()
                web_module._ingest_queue.task_done()
                self.assertNotIn("data", queued_task)
                self.assertIn("payload_path", queued_task)
                self.assertTrue(Path(str(queued_task["payload_path"])).exists())
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
                if previous_stage is None:
                    os.environ.pop("BINDERY_STAGE_DIR", None)
                else:
                    os.environ["BINDERY_STAGE_DIR"] = previous_stage

    def test_large_batch_ingest_stays_on_ingest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            previous_stage = os.environ.get("BINDERY_STAGE_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            os.environ["BINDERY_STAGE_DIR"] = os.path.join(tmp, ".ingest-stage")
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
                location = response.headers.get("location", "")
                self.assertTrue(location.startswith("/ingest?"))
                self.assertIn("toast=", location)
                self.assertIn("toast_kind=success", location)
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
                if previous_stage is None:
                    os.environ.pop("BINDERY_STAGE_DIR", None)
                else:
                    os.environ["BINDERY_STAGE_DIR"] = previous_stage

    def test_ingest_accepts_upload_tokens_without_reupload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            previous_stage = os.environ.get("BINDERY_STAGE_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            os.environ["BINDERY_STAGE_DIR"] = os.path.join(tmp, ".ingest-stage")
            try:
                init_db()
                request = Request({"type": "http", "method": "POST", "headers": []})
                token = web_module._persist_staged_upload(
                    Path(tmp),
                    "token-book.txt",
                    "第一章 开始\n正文".encode("utf-8"),
                    "text/plain",
                    "txt",
                )
                staged_dir = Path(tmp) / web_module.INGEST_STAGE_DIR / token
                self.assertTrue(staged_dir.exists())
                with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
                    response = asyncio.run(
                        ingest(
                            request,
                            files=[],
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
                            upload_tokens=[token],
                        )
                    )
                self.assertEqual(getattr(response, "status_code", None), 303)
                location = response.headers.get("location", "")
                self.assertTrue(location.startswith("/ingest?"))
                self.assertIn("toast=", location)
                self.assertIn("toast_kind=success", location)
                self.assertFalse(staged_dir.exists())
                self.assertEqual(len(list_jobs()), 1)
                queued_task = web_module._ingest_queue.get_nowait()
                web_module._ingest_queue.task_done()
                self.assertNotIn("data", queued_task)
                self.assertIn("payload_path", queued_task)
                self.assertTrue(Path(str(queued_task["payload_path"])).exists())
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
                if previous_stage is None:
                    os.environ.pop("BINDERY_STAGE_DIR", None)
                else:
                    os.environ["BINDERY_STAGE_DIR"] = previous_stage

    def test_ingest_marks_job_failed_when_queue_full(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            previous_stage = os.environ.get("BINDERY_STAGE_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            os.environ["BINDERY_STAGE_DIR"] = os.path.join(tmp, ".ingest-stage")
            try:
                init_db()
                request = Request({"type": "http", "method": "POST", "headers": []})
                with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as spooled:
                    spooled.write("第一章 开始\n正文".encode("utf-8"))
                    spooled.seek(0)
                    upload = UploadFile(filename="sample.txt", file=spooled)
                    with (
                        patch("bindery.web._ensure_ingest_worker_started", return_value=None),
                        patch("bindery.web._enqueue_ingest_task", return_value=False),
                    ):
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
                location = response.headers.get("location", "")
                self.assertTrue(location.startswith("/ingest?"))
                self.assertIn("toast=", location)
                self.assertIn("toast_kind=error", location)
                jobs = list_jobs()
                self.assertEqual(len(jobs), 1)
                self.assertEqual(jobs[0].status, "failed")
                self.assertEqual(jobs[0].stage, "失败")
                self.assertIn("队列", jobs[0].message or "")
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
                if previous_stage is None:
                    os.environ.pop("BINDERY_STAGE_DIR", None)
                else:
                    os.environ["BINDERY_STAGE_DIR"] = previous_stage


if __name__ == "__main__":
    unittest.main()
