import re
import unittest
from pathlib import Path


class LibraryUiTests(unittest.TestCase):
    def test_book_card_hides_path_and_id_text(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "book_card.html").read_text(encoding="utf-8")

        self.assertNotIn("{{ book.path }}", tpl)
        self.assertNotIn('title="{{ book.path }}"', tpl)
        self.assertNotIn('title="{{ book.book_id }}"', tpl)
        self.assertIsNone(re.search(r">\\s*\\{\\{\\s*book\\.book_id\\s*\\}\\}\\s*<", tpl))

    def test_book_card_has_archive_on_hover_and_no_regenerate(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "book_card.html").read_text(encoding="utf-8")

        self.assertIn('{% set detail_url = "/book/" ~ book.book_id ~ "?return_to=" ~ (return_to|urlencode) %}', tpl)
        self.assertIn('href="{{ detail_url }}"', tpl)
        self.assertIn('href="/book/{{ book.book_id }}/download"', tpl)
        self.assertIn('name="next" value="{{ return_to }}"', tpl)
        self.assertIn('action="/book/{{ book.book_id }}/archive"', tpl)
        self.assertIn("group-hover:opacity-100", tpl)
        self.assertIn("group-hover:pointer-events-auto", tpl)
        self.assertNotIn("pb-3 mt-auto", tpl)
        self.assertNotIn("/regenerate", tpl)
        self.assertIn('book.status_class != "ok"', tpl)
        self.assertNotIn('book.status_class == "ok"', tpl)
        self.assertIn("book.read", tpl)
        self.assertIn("已读", tpl)

    def test_book_card_supports_list_layout(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "book_card.html").read_text(encoding="utf-8")
        self.assertIn('data-book-layout="grid"', tpl)
        self.assertIn('data-book-layout="list"', tpl)
        self.assertIn("data-book-select", tpl)
        self.assertIn('href="{{ preview_url }}"', tpl)
        self.assertIn('data-cover-src="{{ book.cover_url }}"', tpl)
        self.assertIsNone(re.search(r"<img\\s+src=\"\\{\\{\\s*book\\.cover_url\\s*\\}\\}\"", tpl))

    def test_index_grid_is_compact(self) -> None:
        root = Path(__file__).resolve().parent.parent
        index = (root / "templates" / "index.html").read_text(encoding="utf-8")
        section = (root / "templates" / "partials" / "library_section.html").read_text(encoding="utf-8")
        self.assertIn('{% include "partials/library_section.html" %}', index)
        self.assertIn("gap-5", section)
        self.assertIn("grid-cols-auto-180", section)
        self.assertIn("data-[view=list]:!grid-cols-1", section)

    def test_index_has_bulk_actions(self) -> None:
        root = Path(__file__).resolve().parent.parent
        index = (root / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn("data-bulk-controls", index)
        self.assertIn('action="/books/download"', index)
        self.assertIn('action="/books/archive"', index)
        self.assertIn("data-bulk-select-all", index)
        self.assertIn("data-bulk-clear", index)

    def test_index_has_read_filter_toggle(self) -> None:
        root = Path(__file__).resolve().parent.parent
        index = (root / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn('name="read_filter"', index)
        self.assertIn("data-read-filter-toggle", index)
        self.assertIn("仅看未读", index)

    def test_index_has_pagination_controls(self) -> None:
        root = Path(__file__).resolve().parent.parent
        index = (root / "templates" / "index.html").read_text(encoding="utf-8")
        section = (root / "templates" / "partials" / "library_section.html").read_text(encoding="utf-8")
        self.assertIn('name="page"', index)
        self.assertIn("data-page-input", index)
        self.assertIn('id="library-section"', section)
        self.assertIn('hx-target="#library-section"', section)
        self.assertIn('hx-vals=\'{"page":"{{ prev_page }}"}\'', section)
        self.assertIn('hx-vals=\'{"page":"{{ next_page }}"}\'', section)

    def test_index_lazy_loads_cover_images_for_active_view(self) -> None:
        root = Path(__file__).resolve().parent.parent
        index = (root / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn("function hydrateCoverImages(view)", index)
        self.assertIn("img[data-cover-src]", index)
        self.assertIn('`[data-book-layout="${view}"] img[data-cover-src]`', index)

    def test_auto_grid_column_uses_flexible_width(self) -> None:
        root = Path(__file__).resolve().parent.parent
        css = (root / "static" / "tailwind.css").read_text(encoding="utf-8")
        self.assertIn("repeat(auto-fill, minmax(180px, 1fr))", css)

    def test_book_detail_and_edit_templates_keep_return_to(self) -> None:
        root = Path(__file__).resolve().parent.parent
        book_tpl = (root / "templates" / "book.html").read_text(encoding="utf-8")
        view_tpl = (root / "templates" / "partials" / "meta_view.html").read_text(encoding="utf-8")
        edit_tpl = (root / "templates" / "partials" / "meta_edit.html").read_text(encoding="utf-8")
        preview_tpl = (root / "templates" / "preview.html").read_text(encoding="utf-8")
        self.assertIn('href="{{ return_to }}"', book_tpl)
        self.assertIn('name="next" value="{{ return_to }}"', book_tpl)
        self.assertIn('{% set edit_url = "/book/" ~ book_id ~ "/edit" ~ return_to_query %}', view_tpl)
        self.assertIn('name="return_to" value="{{ return_to }}"', edit_tpl)
        self.assertIn('{% set detail_url = "/book/" ~ book.book_id ~ return_to_query %}', preview_tpl)


if __name__ == "__main__":
    unittest.main()
