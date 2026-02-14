import unittest
from pathlib import Path


class WishlistUiTests(unittest.TestCase):
    def test_wishlist_template_has_required_fields_and_actions(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "wishlist.html").read_text(encoding="utf-8")

        self.assertIn('action="/tracker"', tpl)
        self.assertIn('method="get"', tpl)
        self.assertIn('name="title"', tpl)
        self.assertIn('name="author"', tpl)
        self.assertIn('name="tags"', tpl)
        self.assertIn('name="rating"', tpl)
        self.assertIn('name="review"', tpl)
        self.assertIn('name="comment"', tpl)
        self.assertIn('name="library_book_id"', tpl)
        self.assertIn('name="read_status"', tpl)
        self.assertIn('name="book_status"', tpl)
        self.assertIn('name="q"', tpl)
        self.assertIn('name="read_filter"', tpl)
        self.assertIn('name="library_filter"', tpl)
        self.assertIn('name="book_status_filter"', tpl)
        self.assertIn('name="next"', tpl)
        self.assertIn("data-open-add-modal", tpl)
        self.assertIn("data-add-modal", tpl)
        self.assertIn("No books match your filters.", tpl)
        self.assertIn('/tracker/{{ wish.id }}/update', tpl)
        self.assertIn('/tracker/{{ wish.id }}/delete', tpl)
        self.assertIn("In Library", tpl)
        self.assertIn("更新中", tpl)
        self.assertIn("已断更", tpl)
        self.assertIn("已完结", tpl)


if __name__ == "__main__":
    unittest.main()
