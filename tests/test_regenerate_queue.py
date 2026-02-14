import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from bindery.db import create_job, init_db, list_jobs
from bindery.models import Book, Job, Metadata
from bindery.storage import epub_path, library_dir, save_book, save_metadata, write_source_file
from bindery.web import _run_regenerate, regenerate, retry_job


class RegenerateQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_library_dir = os.environ.get("BINDERY_LIBRARY_DIR")
        os.environ["BINDERY_LIBRARY_DIR"] = self.tmp.name
        init_db()

    def tearDown(self) -> None:
        self.tmp.cleanup()
        if self.old_library_dir is None:
            os.environ.pop("BINDERY_LIBRARY_DIR", None)
        else:
            os.environ["BINDERY_LIBRARY_DIR"] = self.old_library_dir

    def _create_txt_book(self, book_id: str) -> None:
        base = library_dir()
        meta = Metadata(
            book_id=book_id,
            title="测试书",
            author="作者",
            language="zh-CN",
            description=None,
            source_type="txt",
            rule_template="default",
        )
        save_book(Book(title=meta.title, author=meta.author, intro=None), base, book_id)
        save_metadata(meta, base)
        src = Path(self.tmp.name) / f"{book_id}.txt"
        src.write_text("《测试书》\n作者：作者\n\n第1章 开始\n正文第一段\n", encoding="utf-8")
        write_source_file(base, book_id, src)

    def test_run_regenerate_uses_stream_pipeline(self) -> None:
        base = library_dir()
        book_id = "a" * 32
        self._create_txt_book(book_id)
        job = Job(
            id="job-regenerate-stream",
            book_id=book_id,
            action="regenerate",
            status="running",
            stage="预处理",
            message=None,
            log=None,
            rule_template="default",
            created_at="",
            updated_at="",
        )
        with (
            patch("bindery.web.parse_book_file", side_effect=AssertionError("legacy parse path should not be used")),
            patch("bindery.web.build_epub", side_effect=AssertionError("legacy build path should not be used")),
        ):
            meta = _run_regenerate(job, base, book_id, "default")
        self.assertEqual(meta.status, "synced")
        self.assertTrue(epub_path(base, book_id).exists())

    def test_regenerate_route_enqueues_job(self) -> None:
        book_id = "b" * 32
        self._create_txt_book(book_id)
        queued: list[dict] = []
        with (
            patch("bindery.web._ensure_ingest_worker_started"),
            patch("bindery.web._enqueue_ingest_task", side_effect=lambda task: queued.append(task) or True),
            patch("bindery.web._run_regenerate", side_effect=AssertionError("route should enqueue job")),
        ):
            response = asyncio.run(regenerate(book_id=book_id, rule_template="default", next=f"/book/{book_id}"))

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/jobs?tab=running")
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0].get("kind"), "regenerate")
        self.assertEqual(queued[0].get("book_id"), book_id)
        jobs = list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].action, "regenerate")
        self.assertEqual(jobs[0].stage, "排队中")

    def test_retry_route_enqueues_retry_job(self) -> None:
        book_id = "c" * 32
        self._create_txt_book(book_id)
        now = datetime.now(timezone.utc).isoformat()
        create_job(
            Job(
                id="failed-job",
                book_id=book_id,
                action="regenerate",
                status="failed",
                stage="失败",
                message="转换失败",
                log="traceback",
                rule_template="default",
                created_at=now,
                updated_at=now,
            )
        )

        queued: list[dict] = []
        with (
            patch("bindery.web._ensure_ingest_worker_started"),
            patch("bindery.web._enqueue_ingest_task", side_effect=lambda task: queued.append(task) or True),
            patch("bindery.web._run_regenerate", side_effect=AssertionError("route should enqueue job")),
        ):
            response = asyncio.run(retry_job("failed-job", rule_template="default"))

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/jobs?tab=running")
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0].get("kind"), "regenerate")
        self.assertEqual(queued[0].get("book_id"), book_id)
        jobs = list_jobs()
        self.assertEqual(len(jobs), 2)
        self.assertTrue(any(job.action == "retry" and job.book_id == book_id for job in jobs))

    def test_regenerate_route_marks_job_failed_when_queue_full(self) -> None:
        book_id = "d" * 32
        self._create_txt_book(book_id)
        with (
            patch("bindery.web._ensure_ingest_worker_started"),
            patch("bindery.web._enqueue_ingest_task", return_value=False),
        ):
            response = asyncio.run(regenerate(book_id=book_id, rule_template="default", next=f"/book/{book_id}"))

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/jobs?tab=running")
        jobs = list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].status, "failed")
        self.assertEqual(jobs[0].stage, "失败")
        self.assertIn("队列", jobs[0].message or "")


if __name__ == "__main__":
    unittest.main()
