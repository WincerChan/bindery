import asyncio
import os
import tempfile
import unittest

from starlette.requests import Request

from bindery.db import get_wish, init_db, list_wishes
from bindery.models import Book, Metadata
from bindery.storage import library_dir, save_book, save_metadata
from bindery.web import wishlist_create, wishlist_page, wishlist_remove, wishlist_update


class WishlistTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_library_dir = os.environ.get("BINDERY_LIBRARY_DIR")
        os.environ["BINDERY_LIBRARY_DIR"] = self.tmp.name
        init_db()

    def tearDown(self) -> None:
        self.tmp.cleanup()
        if self.old_library_dir is None:
            os.environ.pop("BINDERY_LIBRARY_DIR", None)
        else:
            os.environ["BINDERY_LIBRARY_DIR"] = self.old_library_dir

    def test_wishlist_create_update_delete(self) -> None:
        response = asyncio.run(
            wishlist_create(
                title="诡秘之主",
                author="爱潜水的乌贼",
                rating="5",
                read="1",
                book_status="completed",
            )
        )
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/wishlist")

        wishes = list_wishes()
        self.assertEqual(len(wishes), 1)
        wish = wishes[0]
        self.assertEqual(wish.title, "诡秘之主")
        self.assertEqual(wish.author, "爱潜水的乌贼")
        self.assertEqual(wish.rating, 5)
        self.assertTrue(wish.read)
        self.assertEqual(wish.book_status, "completed")

        response_update = asyncio.run(
            wishlist_update(
                wish.id,
                title="诡秘之主（重读）",
                author="爱潜水的乌贼",
                rating="",
                read="0",
                book_status="hiatus",
            )
        )
        self.assertEqual(response_update.status_code, 303)
        self.assertEqual(response_update.headers.get("location"), "/wishlist")

        updated = get_wish(wish.id)
        self.assertIsNotNone(updated)
        assert updated is not None
        self.assertEqual(updated.title, "诡秘之主（重读）")
        self.assertIsNone(updated.rating)
        self.assertFalse(updated.read)
        self.assertEqual(updated.book_status, "hiatus")

        response_delete = asyncio.run(wishlist_remove(wish.id))
        self.assertEqual(response_delete.status_code, 303)
        self.assertEqual(response_delete.headers.get("location"), "/wishlist")
        self.assertIsNone(get_wish(wish.id))

    def test_wishlist_marks_existing_book_in_library(self) -> None:
        base = library_dir()
        book_id = "a" * 32
        save_book(Book(title="雪中悍刀行", author="烽火戏诸侯", intro=None), base, book_id)
        save_metadata(
            Metadata(
                book_id=book_id,
                title="雪中悍刀行",
                author="烽火戏诸侯",
                language="zh-CN",
                description=None,
            ),
            base,
        )

        asyncio.run(
            wishlist_create(
                title="雪中悍刀行",
                author="烽火戏诸侯",
                rating="4",
                read="0",
                book_status="ongoing",
            )
        )

        request = Request({"type": "http", "method": "GET", "path": "/wishlist", "headers": []})
        response = asyncio.run(wishlist_page(request))
        wishes = response.context.get("wishes", [])
        self.assertTrue(wishes)
        self.assertTrue(wishes[0].get("exists_in_library"))


if __name__ == "__main__":
    unittest.main()
