import asyncio
import csv
import os
import tempfile
import unittest
from io import StringIO

from bindery.db import create_wish, init_db
from bindery.models import Wish
from bindery.web import tracker_export


class TrackerExportTests(unittest.TestCase):
    def test_tracker_export_outputs_filtered_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old_library = os.environ.get("BINDERY_LIBRARY_DIR")
            old_db = os.environ.get("BINDERY_DB_PATH")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            try:
                init_db()
                create_wish(
                    Wish(
                        id="a" * 32,
                        title="三体",
                        author="刘慈欣",
                        rating=5,
                        read=False,
                        read_status="reading",
                        tags=["科幻"],
                        comment="准备重读",
                        book_status="completed",
                        created_at="2026-04-01T10:00:00+00:00",
                        updated_at="2026-04-01T10:00:00+00:00",
                    )
                )
                create_wish(
                    Wish(
                        id="b" * 32,
                        title="球状闪电",
                        author="刘慈欣",
                        rating=4,
                        read=True,
                        read_status="read",
                        tags=["科幻"],
                        comment="已看完",
                        book_status="completed",
                        created_at="2026-04-02T10:00:00+00:00",
                        updated_at="2026-04-02T10:00:00+00:00",
                    )
                )

                response = asyncio.run(
                    tracker_export(
                        q="刘慈欣",
                        read_filter="reading",
                        library_filter="all",
                        book_status_filter="all",
                    )
                )

                self.assertEqual(response.headers["content-disposition"].startswith("attachment; filename="), True)
                rows = list(csv.reader(StringIO(response.body.decode("utf-8-sig"))))
                self.assertEqual(rows[0], ["title", "author", "rating", "comment", "date"])
                self.assertEqual(
                    rows[1],
                    ["三体", "刘慈欣", "5", "准备重读", "2026-04-01T10:00:00+00:00"],
                )
                self.assertEqual(len(rows), 2)
            finally:
                if old_library is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = old_library
                if old_db is None:
                    os.environ.pop("BINDERY_DB_PATH", None)
                else:
                    os.environ["BINDERY_DB_PATH"] = old_db

    def test_tracker_export_keeps_empty_rating_and_comment_columns(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old_library = os.environ.get("BINDERY_LIBRARY_DIR")
            old_db = os.environ.get("BINDERY_DB_PATH")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_DB_PATH"] = os.path.join(tmp, "bindery.db")
            try:
                init_db()
                create_wish(
                    Wish(
                        id="c" * 32,
                        title="未评分作品",
                        author=None,
                        rating=None,
                        read=False,
                        read_status="unread",
                        tags=[],
                        comment=None,
                        book_status="ongoing",
                        created_at="2026-04-03T10:00:00+00:00",
                        updated_at="2026-04-03T10:00:00+00:00",
                    )
                )

                response = asyncio.run(tracker_export())

                rows = list(csv.reader(StringIO(response.body.decode("utf-8-sig"))))
                self.assertEqual(rows[1], ["未评分作品", "", "", "", "2026-04-03T10:00:00+00:00"])
            finally:
                if old_library is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = old_library
                if old_db is None:
                    os.environ.pop("BINDERY_DB_PATH", None)
                else:
                    os.environ["BINDERY_DB_PATH"] = old_db


if __name__ == "__main__":
    unittest.main()
