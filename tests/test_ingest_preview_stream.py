import asyncio
import os
import tempfile
import unittest
from unittest.mock import patch

from starlette.datastructures import UploadFile
from starlette.requests import Request

from bindery.db import init_db
from bindery.web import ingest_preview


class IngestPreviewStreamTests(unittest.TestCase):
    def test_txt_preview_uses_event_stream_pipeline(self) -> None:
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
                    spooled.write("第一章 起始\n正文内容\n".encode("utf-8"))
                    spooled.seek(0)
                    upload = UploadFile(filename="preview.txt", file=spooled)
                    with patch(
                        "bindery.web.parse_book_file",
                        side_effect=AssertionError("legacy parse path should not be used in preview"),
                    ):
                        response = asyncio.run(
                            ingest_preview(
                                request,
                                files=[upload],
                                rule_template="default",
                                theme_template="",
                            )
                        )
                    self.assertTrue(upload.file.closed)

                self.assertEqual(response.status_code, 200)
            finally:
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
