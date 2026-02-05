import unittest
from pathlib import Path


class BookDetailUiTests(unittest.TestCase):
    def test_book_detail_template_has_actions_and_no_cover_management(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "book.html").read_text(encoding="utf-8")

        self.assertIn('href="/book/{{ book_id }}/download"', tpl)
        self.assertIn('href="/book/{{ book_id }}/preview"', tpl)
        self.assertIn('action="/book/{{ book_id }}/archive"', tpl)

        self.assertNotIn("封面管理", tpl)
        self.assertNotIn("/cover/upload", tpl)
        self.assertNotIn("/cover/url", tpl)
        self.assertNotIn("/cover/extract", tpl)

    def test_meta_partials_use_title_header_and_single_save(self) -> None:
        root = Path(__file__).resolve().parent.parent
        view = (root / "templates" / "partials" / "meta_view.html").read_text(encoding="utf-8")
        edit = (root / "templates" / "partials" / "meta_edit.html").read_text(encoding="utf-8")

        self.assertNotIn("元数据", view)
        self.assertIn("{{ book.title }}", view)

        self.assertNotIn("元数据", edit)
        self.assertIn("保存并写回", edit)
        self.assertIn("封面将从书籍本身读取", edit)


if __name__ == "__main__":
    unittest.main()

