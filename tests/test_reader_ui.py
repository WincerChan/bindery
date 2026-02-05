import unittest
from pathlib import Path


class ReaderUiTests(unittest.TestCase):
    def test_preview_template_has_toc_and_controls(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "preview.html").read_text(encoding="utf-8")

        self.assertIn('x-data="binderyReader()', tpl)
        self.assertIn("目录", tpl)
        self.assertIn('x-model="fontFamily"', tpl)
        self.assertIn("fontSize", tpl)
        self.assertIn("上一页", tpl)
        self.assertIn("下一页", tpl)
        self.assertIn("pageCount", tpl)
        self.assertIn("pagePrev", tpl)
        self.assertIn("pageNext", tpl)
        self.assertIn("bindery-reader-scroller", tpl)
        self.assertIn('x-ref="frame"', tpl)
        self.assertIn("styleMode", tpl)
        self.assertIn("settingsOpen", tpl)
        self.assertIn("readerBg", tpl)
        self.assertIn("lineHeight", tpl)
        self.assertIn("设置", tpl)
        self.assertIn("binderyKeyListener", tpl)
        self.assertIn("bindery-theme-on", tpl)
        self.assertIn("书籍", tpl)
        self.assertIn("自定义", tpl)
        self.assertIn(":class=\"tocOpen ? 'translate-x-0' : '-translate-x-full'\"", tpl)
        self.assertIn('src="{{ book.cover_url }}"', tpl)
        self.assertIn("timeNow", tpl)
        self.assertNotIn("md:opacity-0", tpl)
        self.assertNotIn("md:group-hover:opacity-100", tpl)

    def test_base_supports_fullscreen_layout(self) -> None:
        root = Path(__file__).resolve().parent.parent
        base = (root / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn("hide_nav", base)
        self.assertIn("main_class", base)


if __name__ == "__main__":
    unittest.main()
