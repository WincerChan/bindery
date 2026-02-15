import asyncio
import os
import queue
import tempfile
import unittest
from unittest.mock import patch

from starlette.datastructures import UploadFile
from starlette.requests import Request

from bindery.db import create_wish, get_wish_by_library_book_id, init_db, list_wishes
from bindery.models import Wish
from bindery.storage import library_dir, list_books
from bindery.web import ingest, ingest_preview
import bindery.web as web_module


class IngestDedupeTests(unittest.TestCase):
    def _make_upload(self, name: str, content: str) -> UploadFile:
        spooled = tempfile.SpooledTemporaryFile(max_size=1024 * 1024)
        spooled.write(content.encode("utf-8"))
        spooled.seek(0)
        return UploadFile(filename=name, file=spooled)

    def _drain_queue(self) -> None:
        while True:
            try:
                web_module._ingest_queue.get_nowait()
                web_module._ingest_queue.task_done()
            except queue.Empty:
                break

    def _assert_ingest_success_redirect(self, response) -> None:
        location = response.headers.get("location", "")
        self.assertTrue(location.startswith("/ingest?"))
        self.assertIn("toast=", location)
        self.assertIn("toast_kind=success", location)

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
                with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
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
                self._assert_ingest_success_redirect(response_first)
                first_task = web_module._ingest_queue.get_nowait()
                web_module._process_queued_ingest_task(first_task)
                web_module._ingest_queue.task_done()
                books_after_first = list_books(library_dir())
                self.assertEqual(len(books_after_first), 1)
                existing_id = books_after_first[0].book_id

                second_upload = self._make_upload("second.txt", "第一章 起点\n正文")
                with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
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
                self._assert_ingest_success_redirect(response_second)

                second_task = web_module._ingest_queue.get_nowait()
                web_module._process_queued_ingest_task(second_task)
                web_module._ingest_queue.task_done()

                books_after_second = list_books(library_dir())
                self.assertEqual(len(books_after_second), 1)
                self.assertEqual(getattr(response_second, "status_code", None), 303)
                self.assertEqual(books_after_second[0].book_id, existing_id)
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

    def test_normalize_mode_reuses_existing_book_when_new_author_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            try:
                init_db()
                request = Request({"type": "http", "method": "POST", "headers": []})
                first_upload = self._make_upload("first.txt", "第一章 起点\n正文")
                with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
                    response_first = asyncio.run(
                        ingest(
                            request,
                            files=[first_upload],
                            title="同名样例",
                            author="作者甲",
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
                self._assert_ingest_success_redirect(response_first)
                first_task = web_module._ingest_queue.get_nowait()
                web_module._process_queued_ingest_task(first_task)
                web_module._ingest_queue.task_done()
                books_after_first = list_books(library_dir())
                self.assertEqual(len(books_after_first), 1)
                existing_id = books_after_first[0].book_id

                second_upload = self._make_upload("second.txt", "第一章 起点\n正文")
                with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
                    response_second = asyncio.run(
                        ingest(
                            request,
                            files=[second_upload],
                            title="同名样例",
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
                self._assert_ingest_success_redirect(response_second)

                second_task = web_module._ingest_queue.get_nowait()
                web_module._process_queued_ingest_task(second_task)
                web_module._ingest_queue.task_done()

                books_after_second = list_books(library_dir())
                self.assertEqual(len(books_after_second), 1)
                self.assertEqual(getattr(response_second, "status_code", None), 303)
                self.assertEqual(books_after_second[0].book_id, existing_id)
                self.assertEqual(books_after_second[0].author, "作者甲")
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

    def test_ingest_creates_tracker_immediately_without_page_visit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            try:
                init_db()
                request = Request({"type": "http", "method": "POST", "headers": []})
                upload = self._make_upload("tracker-sync.txt", "第一章 起点\n正文")
                with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
                    response = asyncio.run(
                        ingest(
                            request,
                            files=[upload],
                            title="立即同步追踪",
                            author="测试作者",
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
                upload.file.close()
                self.assertEqual(getattr(response, "status_code", None), 303)
                self._assert_ingest_success_redirect(response)

                queued_task = web_module._ingest_queue.get_nowait()
                web_module._process_queued_ingest_task(queued_task)
                web_module._ingest_queue.task_done()

                books = list_books(library_dir())
                self.assertEqual(len(books), 1)
                wish = get_wish_by_library_book_id(books[0].book_id)
                self.assertIsNotNone(wish)
                assert wish is not None
                self.assertEqual(wish.title, "立即同步追踪")
                self.assertEqual(wish.author, "测试作者")
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

    def test_ingest_binds_matching_unlinked_tracker_instead_of_creating_new_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            try:
                init_db()
                manual_wish_id = "f" * 32
                create_wish(
                    Wish(
                        id=manual_wish_id,
                        title="手动追踪书",
                        author="手动作者",
                        library_book_id=None,
                        rating=5,
                        read=False,
                        read_status="reading",
                        tags=["待看"],
                        comment="先记下来",
                        book_status="ongoing",
                        created_at="2026-01-01T00:00:00+00:00",
                        updated_at="2026-01-01T00:00:00+00:00",
                    )
                )

                request = Request({"type": "http", "method": "POST", "headers": []})
                upload = self._make_upload("bind-existing.txt", "第一章 起点\n正文")
                with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
                    response = asyncio.run(
                        ingest(
                            request,
                            files=[upload],
                            title="手动追踪书",
                            author="手动作者",
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
                upload.file.close()
                self.assertEqual(getattr(response, "status_code", None), 303)
                self._assert_ingest_success_redirect(response)

                queued_task = web_module._ingest_queue.get_nowait()
                web_module._process_queued_ingest_task(queued_task)
                web_module._ingest_queue.task_done()

                books = list_books(library_dir())
                self.assertEqual(len(books), 1)
                wishes = list_wishes()
                self.assertEqual(len(wishes), 1)
                self.assertEqual(wishes[0].id, manual_wish_id)
                self.assertEqual(wishes[0].library_book_id, books[0].book_id)
                self.assertEqual(wishes[0].read_status, "reading")
                self.assertEqual(wishes[0].rating, 5)
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

    def test_txt_ingest_can_fallback_title_author_from_filename(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_library = os.environ.get("BINDERY_LIBRARY_DIR")
            previous_db = os.environ.get("BINDERY_DB_PATH")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            try:
                init_db()
                request = Request({"type": "http", "method": "POST", "headers": []})
                upload = self._make_upload(
                    "《七界第一仙》（校对版全本）作者：流牙.txt",
                    "==========================================================\n\n第1章 起始\n正文内容\n",
                )
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
                upload.file.close()
                self.assertEqual(getattr(response, "status_code", None), 303)
                self._assert_ingest_success_redirect(response)

                queued_task = web_module._ingest_queue.get_nowait()
                web_module._process_queued_ingest_task(queued_task)
                web_module._ingest_queue.task_done()

                books = list_books(library_dir())
                self.assertEqual(len(books), 1)
                self.assertEqual(books[0].title, "七界第一仙")
                self.assertEqual(books[0].author, "流牙")
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

    def test_staged_ingest_allows_per_file_dedupe_override(self) -> None:
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
                first_upload = self._make_upload("keep.txt", "第一章 起点\n正文")
                second_upload = self._make_upload("normalize.txt", "第一章 起点\n正文")
                preview_response = asyncio.run(
                    ingest_preview(
                        request,
                        files=[first_upload, second_upload],
                        rule_template="default",
                        theme_template="",
                    )
                )
                self.assertEqual(preview_response.status_code, 200)
                previews = preview_response.context.get("previews") or []
                self.assertEqual(len(previews), 2)
                tokens = [str(item.get("upload_token") or "") for item in previews]
                self.assertTrue(all(tokens))
                keep_token = tokens[0]

                with patch("bindery.web._ensure_ingest_worker_started", return_value=None):
                    response = asyncio.run(
                        ingest(
                            request,
                            files=None,
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
                            dedupe_mode="normalize",
                            dedupe_keep_tokens=[keep_token],
                            cover_file=None,
                            upload_tokens=tokens,
                        )
                    )
                self.assertEqual(getattr(response, "status_code", None), 303)
                self._assert_ingest_success_redirect(response)

                queued_tasks = [web_module._ingest_queue.get_nowait(), web_module._ingest_queue.get_nowait()]
                for _ in queued_tasks:
                    web_module._ingest_queue.task_done()
                mode_by_filename = {str(task.get("filename")): str(task.get("dedupe_mode")) for task in queued_tasks}
                self.assertEqual(mode_by_filename.get("keep.txt"), "keep")
                self.assertEqual(mode_by_filename.get("normalize.txt"), "normalize")
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
