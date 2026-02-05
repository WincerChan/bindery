import unittest
from pathlib import Path


class ThemeDefaultsUiTests(unittest.TestCase):
    def test_ingest_template_defaults_theme_and_has_keep_book_option(self) -> None:
        root = Path(__file__).resolve().parent.parent
        ingest = (root / "templates" / "ingest.html").read_text(encoding="utf-8")
        self.assertIn('name="theme_template"', ingest)
        self.assertIn('value="__book__"', ingest)
        self.assertIn('theme.theme_id == "default"', ingest)

    def test_meta_edit_template_uses_effective_theme_template(self) -> None:
        root = Path(__file__).resolve().parent.parent
        edit = (root / "templates" / "partials" / "meta_edit.html").read_text(encoding="utf-8")
        self.assertIn('value="__book__"', edit)
        self.assertIn("book.effective_theme_template", edit)


if __name__ == "__main__":
    unittest.main()

