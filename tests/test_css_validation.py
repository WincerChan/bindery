import unittest

from bindery.css import MAX_CSS_LENGTH, validate_css


class CssValidationTests(unittest.TestCase):
    def test_accepts_empty(self) -> None:
        self.assertIsNone(validate_css(""))
        self.assertIsNone(validate_css("   "))

    def test_accepts_valid_css(self) -> None:
        self.assertIsNone(validate_css("body { color: red; }"))

    def test_rejects_unbalanced_braces(self) -> None:
        self.assertIsNotNone(validate_css("body { color: red;"))
        self.assertIsNotNone(validate_css("} body { color: red; }"))

    def test_rejects_unclosed_string(self) -> None:
        self.assertIsNotNone(validate_css('body { content: "oops; }'))

    def test_rejects_unclosed_comment(self) -> None:
        self.assertIsNotNone(validate_css("/* comment"))

    def test_rejects_too_long(self) -> None:
        too_long = "a" * (MAX_CSS_LENGTH + 1)
        self.assertIsNotNone(validate_css(too_long))


if __name__ == "__main__":
    unittest.main()
