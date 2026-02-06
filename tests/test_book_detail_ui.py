import unittest
from pathlib import Path


class BookDetailUiTests(unittest.TestCase):
    def test_book_detail_template_has_actions_and_no_cover_management(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "meta_view.html").read_text(encoding="utf-8")

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
        self.assertNotIn("Identifier", view)
        self.assertIn("[:10]", view)
        self.assertIn('hx-swap="outerHTML"', view)

        self.assertNotIn("元数据", edit)
        self.assertIn("保存并写回", edit)
        self.assertIn('enctype="multipart/form-data"', edit)
        self.assertIn('hx-encoding="multipart/form-data"', edit)
        self.assertIn('hx-swap="outerHTML"', edit)
        self.assertIn('name="cover_file"', edit)
        self.assertIn('name="cover_url"', edit)
        self.assertNotIn('name="identifier"', edit)
        self.assertIn('contenteditable="true"', edit)
        self.assertIn('data-edit-field="title"', edit)
        self.assertIn('data-rating-star="{{ i }}"', edit)
        self.assertIn('data-rating-input', edit)


if __name__ == "__main__":
    unittest.main()
