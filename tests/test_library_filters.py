import os
import tempfile
import unittest
from unittest.mock import patch

from bindery.db import create_wish
from bindery.models import Metadata, Wish
from bindery.storage import library_dir, save_metadata
from bindery.web import _library_page_data


class LibraryFilterTests(unittest.TestCase):
    def test_library_page_size_is_24(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                for idx in range(25):
                    book_id = f"{idx:032x}"[-32:]
                    save_metadata(
                        Metadata(
                            book_id=book_id,
                            title=f"书-{idx}",
                            author="A",
                            language="zh-CN",
                            description=None,
                            updated_at=f"2026-02-06T00:00:{idx:02d}+00:00",
                        ),
                        base,
                    )

                page1 = _library_page_data(base, "updated", "", 1, "all")
                page2 = _library_page_data(base, "updated", "", 2, "all")

                self.assertEqual(page1["total_books"], 25)
                self.assertEqual(page1["total_pages"], 2)
                self.assertEqual(len(page1["books"]), 24)
                self.assertEqual(len(page2["books"]), 1)
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev

    def test_library_page_data_accepts_custom_per_page(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                for idx in range(21):
                    book_id = f"{idx:032x}"[-32:]
                    save_metadata(
                        Metadata(
                            book_id=book_id,
                            title=f"书-{idx}",
                            author="A",
                            language="zh-CN",
                            description=None,
                            updated_at=f"2026-02-06T00:00:{idx:02d}+00:00",
                        ),
                        base,
                    )

                page1 = _library_page_data(base, "updated", "", 1, "all", per_page=20)
                page2 = _library_page_data(base, "updated", "", 2, "all", per_page=20)

                self.assertEqual(page1["per_page"], 20)
                self.assertEqual(page1["total_pages"], 2)
                self.assertEqual(len(page1["books"]), 20)
                self.assertEqual(len(page2["books"]), 1)
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev

    def test_library_page_data_can_filter_unread_books(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                save_metadata(
                    Metadata(
                        book_id="a" * 32,
                        title="未读书",
                        author="A",
                        language="zh-CN",
                        description=None,
                        read=False,
                        updated_at="2026-02-06T00:00:00+00:00",
                    ),
                    base,
                )
                save_metadata(
                    Metadata(
                        book_id="b" * 32,
                        title="已读书",
                        author="B",
                        language="zh-CN",
                        description=None,
                        read=True,
                        updated_at="2026-02-06T00:00:01+00:00",
                    ),
                    base,
                )

                payload = _library_page_data(base, "updated", "", 1, "unread")

                self.assertEqual(payload["read_filter"], "unread")
                self.assertEqual(payload["total_books"], 1)
                self.assertEqual(len(payload["books"]), 1)
                self.assertFalse(payload["books"][0]["read"])
                self.assertEqual(payload["books"][0]["title"], "未读书")
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev

    def test_library_page_data_invalid_read_filter_falls_back_to_all(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                save_metadata(
                    Metadata(
                        book_id="c" * 32,
                        title="A",
                        author=None,
                        language="zh-CN",
                        description=None,
                        read=False,
                    ),
                    base,
                )
                save_metadata(
                    Metadata(
                        book_id="d" * 32,
                        title="B",
                        author=None,
                        language="zh-CN",
                        description=None,
                        read=True,
                    ),
                    base,
                )

                payload = _library_page_data(base, "updated", "", 1, "unexpected")

                self.assertEqual(payload["read_filter"], "all")
                self.assertEqual(payload["total_books"], 2)
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev

    def test_library_page_data_unread_filter_uses_wishlist_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                book_id = "e" * 32
                save_metadata(
                    Metadata(
                        book_id=book_id,
                        title="由追踪标记已读",
                        author="A",
                        language="zh-CN",
                        description=None,
                        read=False,
                        updated_at="2026-02-06T00:00:00+00:00",
                    ),
                    base,
                )
                create_wish(
                    Wish(
                        id="f" * 32,
                        title="由追踪标记已读",
                        library_book_id=book_id,
                        author="A",
                        rating=None,
                        read=True,
                        read_status="read",
                        tags=[],
                        review=None,
                        comment=None,
                        book_status="ongoing",
                        created_at="2026-02-06T00:00:00+00:00",
                        updated_at="2026-02-06T00:00:00+00:00",
                    )
                )

                payload = _library_page_data(base, "updated", "", 1, "unread")

                self.assertEqual(payload["read_filter"], "unread")
                self.assertEqual(payload["total_books"], 0)
                self.assertEqual(len(payload["books"]), 0)
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev

    def test_library_page_data_uses_paged_storage_query(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                base = library_dir()
                sample = Metadata(
                    book_id="f" * 32,
                    title="分页样例",
                    author="A",
                    language="zh-CN",
                    description=None,
                    updated_at="2026-02-06T00:00:01+00:00",
                )
                save_metadata(sample, base)
                with (
                    patch("bindery.web.list_books", side_effect=AssertionError("legacy full-scan should not be used")),
                    patch("bindery.web.list_books_page", return_value=([sample], 1)) as paged_query,
                ):
                    payload = _library_page_data(base, "updated", "", 1, "all")
                self.assertEqual(payload["total_books"], 1)
                self.assertEqual(len(payload["books"]), 1)
                paged_query.assert_called_once()
            finally:
                if prev is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev


if __name__ == "__main__":
    unittest.main()
