import unittest
from pathlib import Path


class CssFormatUiTests(unittest.TestCase):
    def test_ingest_has_css_formatter(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "ingest.html").read_text(encoding="utf-8")
        self.assertIn('data-format-target="ingest-custom-css"', tpl)
        self.assertIn("formatCssText", tpl)

    def test_meta_edit_has_css_formatter(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "meta_edit.html").read_text(encoding="utf-8")
        self.assertIn('data-format-target="book-custom-css"', tpl)
        self.assertIn("formatCssText", tpl)

    def test_theme_editor_has_css_formatter(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "theme_editor.html").read_text(encoding="utf-8")
        self.assertIn('@click="formatCss()"', tpl)
        self.assertIn("formatCssText", tpl)


if __name__ == "__main__":
    unittest.main()
