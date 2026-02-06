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

        self.assertIn('href="/book/{{ book.book_id }}"', tpl)
        self.assertIn('href="/book/{{ book.book_id }}/download"', tpl)
        self.assertIn('action="/book/{{ book.book_id }}/archive"', tpl)
        self.assertIn("group-hover:opacity-100", tpl)
        self.assertIn("group-hover:pointer-events-auto", tpl)
        self.assertNotIn("pb-3 mt-auto", tpl)
        self.assertNotIn("/regenerate", tpl)
        self.assertIn('book.status_class != "ok"', tpl)
        self.assertNotIn('book.status_class == "ok"', tpl)

    def test_book_card_supports_list_layout(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "book_card.html").read_text(encoding="utf-8")
        self.assertIn('data-book-layout="grid"', tpl)
        self.assertIn('data-book-layout="list"', tpl)
        self.assertIn("data-book-select", tpl)
        self.assertIn('href="/book/{{ book.book_id }}/preview"', tpl)

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

    def test_auto_grid_column_uses_flexible_width(self) -> None:
        root = Path(__file__).resolve().parent.parent
        css = (root / "static" / "tailwind.css").read_text(encoding="utf-8")
        self.assertIn("repeat(auto-fill, minmax(180px, 1fr))", css)


if __name__ == "__main__":
    unittest.main()
