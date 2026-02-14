import unittest
from pathlib import Path


class WishlistUiTests(unittest.TestCase):
    def test_wishlist_template_has_required_fields_and_actions(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "wishlist.html").read_text(encoding="utf-8")

        self.assertIn('action="/wishlist"', tpl)
        self.assertIn('name="title"', tpl)
        self.assertIn('name="author"', tpl)
        self.assertIn('name="rating"', tpl)
        self.assertIn('name="read"', tpl)
        self.assertIn('name="book_status"', tpl)
        self.assertIn('/wishlist/{{ wish.id }}/update', tpl)
        self.assertIn('/wishlist/{{ wish.id }}/delete', tpl)
        self.assertIn("已存在库中", tpl)
        self.assertIn("更新中", tpl)
        self.assertIn("已断更", tpl)
        self.assertIn("已完结", tpl)


if __name__ == "__main__":
    unittest.main()
