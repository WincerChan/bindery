import unittest
import urllib.request
from unittest.mock import patch

from bindery.web import _download_cover_from_url


class CoverDownloadHeaderTests(unittest.TestCase):
    def test_download_douban_cover_sets_referer_header(self) -> None:
        with patch("bindery.web.urllib.request.urlopen") as mocked_urlopen:
            mocked_urlopen.return_value.__enter__.return_value.read.return_value = b"cover-bytes"

            data, filename = _download_cover_from_url(
                "https://img3.doubanio.com/view/subject/l/public/s7654321.jpg"
            )

            self.assertEqual(data, b"cover-bytes")
            self.assertEqual(filename, "s7654321.jpg")
            request_obj = mocked_urlopen.call_args.args[0]
            self.assertIsInstance(request_obj, urllib.request.Request)
            headers = {name.lower(): value for name, value in request_obj.header_items()}
            self.assertEqual(headers.get("referer"), "https://book.douban.com")

    def test_download_non_douban_cover_uses_plain_url(self) -> None:
        with patch("bindery.web.urllib.request.urlopen") as mocked_urlopen:
            mocked_urlopen.return_value.__enter__.return_value.read.return_value = b"cover-bytes"

            data, filename = _download_cover_from_url("https://example.com/assets/cover.jpg")

            self.assertEqual(data, b"cover-bytes")
            self.assertEqual(filename, "cover.jpg")
            request_obj = mocked_urlopen.call_args.args[0]
            self.assertEqual(request_obj, "https://example.com/assets/cover.jpg")


if __name__ == "__main__":
    unittest.main()
