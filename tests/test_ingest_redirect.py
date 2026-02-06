import asyncio
import os
import tempfile
import unittest

from starlette.datastructures import UploadFile
from starlette.requests import Request

from bindery.web import ingest


class IngestRedirectTests(unittest.TestCase):
    def test_single_ingest_redirects_to_edit_page(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            try:
                request = Request({"type": "http", "method": "POST", "headers": []})
                with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as spooled:
                    spooled.write("第一章 开始\n正文".encode("utf-8"))
                    spooled.seek(0)
                    upload = UploadFile(filename="sample.txt", file=spooled)
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
                self.assertTrue(location.startswith("/book/"), location)
                self.assertTrue(location.endswith("/edit"), location)
            finally:
                if previous is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = previous


if __name__ == "__main__":
    unittest.main()
