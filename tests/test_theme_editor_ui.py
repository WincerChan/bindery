import unittest
from pathlib import Path


class ThemeEditorUiTests(unittest.TestCase):
    def test_theme_editor_partial_does_not_require_inline_scripts(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "theme_editor.html").read_text(encoding="utf-8")
        self.assertNotIn("binderyThemeEditor", tpl)
        self.assertNotIn("<script", tpl.lower())


if __name__ == "__main__":
    unittest.main()

