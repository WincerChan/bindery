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

    def test_book_card_supports_list_layout(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "book_card.html").read_text(encoding="utf-8")
        self.assertIn('data-book-layout="grid"', tpl)
        self.assertIn('data-book-layout="list"', tpl)
        self.assertIn('href="/book/{{ book.book_id }}/preview"', tpl)

    def test_index_grid_is_compact(self) -> None:
        root = Path(__file__).resolve().parent.parent
        index = (root / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn("gap-5", index)
        self.assertIn("grid-cols-auto-180", index)
        self.assertIn("data-[view=list]:!grid-cols-1", index)


if __name__ == "__main__":
    unittest.main()
