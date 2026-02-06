import unittest
from pathlib import Path


class BookDetailUiTests(unittest.TestCase):
    def test_book_detail_template_has_actions_and_no_cover_management(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "meta_view.html").read_text(encoding="utf-8")

        self.assertIn('href="/book/{{ book_id }}/download"', tpl)
        self.assertIn('href="/book/{{ book_id }}/preview"', tpl)
        self.assertIn('action="/book/{{ book_id }}/archive"', tpl)
        self.assertIn('action="/book/{{ book_id }}/read"', tpl)
        self.assertIn("阅读状态", tpl)
        self.assertIn('{{ "已读" if book.read else "未读" }}', tpl)

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
        self.assertIn('data-fetch-metadata', edit)
        self.assertIn('hx-post="/book/{{ book_id }}/metadata/fetch"', edit)
        self.assertIn('name="metadata_source"', edit)
        self.assertIn("data-apply-source", edit)
        self.assertIn("lookup_sources", edit)
        self.assertIn("lookup-changed-fields", edit)
        self.assertIn("lookup-candidates-data", edit)
        self.assertIn("data-lookup-allow-cover-fill", edit)
        self.assertIn("applyLookupSource", edit)
        self.assertIn("data-autofill-target", edit)
        self.assertIn("book.cover_fetch_url", edit)
        self.assertIn("data-fetch-status", edit)


if __name__ == "__main__":
    unittest.main()
