import unittest

from bindery.web import _library_return_to_url, _safe_internal_redirect_target


class ReturnNavigationTests(unittest.TestCase):
    def test_safe_internal_redirect_target_accepts_internal_path(self) -> None:
        target = _safe_internal_redirect_target("/?sort=updated&page=2&read_filter=unread", "/")
        self.assertEqual(target, "/?sort=updated&page=2&read_filter=unread")

    def test_safe_internal_redirect_target_rejects_external_or_protocol_relative(self) -> None:
        self.assertEqual(_safe_internal_redirect_target("https://evil.example/x", "/fallback"), "/fallback")
        self.assertEqual(_safe_internal_redirect_target("//evil.example/x", "/fallback"), "/fallback")

    def test_library_return_to_url_normalizes_sort_and_filter(self) -> None:
        url = _library_return_to_url("unexpected", "abc", 0, "unexpected")
        self.assertEqual(url, "/?sort=updated&q=abc&page=1&read_filter=all")


if __name__ == "__main__":
    unittest.main()
