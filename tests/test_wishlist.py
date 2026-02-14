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
                tags="克苏鲁, 蒸汽朋克",
                rating="5",
                review="世界观很强",
                comment="前中期节奏很好",
                read_status="read",
                book_status="completed",
            )
        )
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/tracker")

        wishes = list_wishes()
        self.assertEqual(len(wishes), 1)
        wish = wishes[0]
        self.assertEqual(wish.title, "诡秘之主")
        self.assertEqual(wish.author, "爱潜水的乌贼")
        self.assertEqual(wish.rating, 5)
        self.assertTrue(wish.read)
        self.assertEqual(wish.read_status, "read")
        self.assertEqual(wish.tags, ["克苏鲁", "蒸汽朋克"])
        self.assertEqual(wish.review, "世界观很强")
        self.assertEqual(wish.comment, "前中期节奏很好")
        self.assertEqual(wish.book_status, "completed")

        response_update = asyncio.run(
            wishlist_update(
                wish.id,
                title="诡秘之主（重读）",
                author="爱潜水的乌贼",
                tags="克苏鲁",
                rating="",
                review="重读依然出色",
                comment="主线收束很稳",
                read_status="reading",
                book_status="hiatus",
            )
        )
        self.assertEqual(response_update.status_code, 303)
        self.assertEqual(response_update.headers.get("location"), "/tracker")

        updated = get_wish(wish.id)
        self.assertIsNotNone(updated)
        assert updated is not None
        self.assertEqual(updated.title, "诡秘之主（重读）")
        self.assertIsNone(updated.rating)
        self.assertFalse(updated.read)
        self.assertEqual(updated.read_status, "reading")
        self.assertEqual(updated.tags, ["克苏鲁"])
        self.assertEqual(updated.review, "重读依然出色")
        self.assertEqual(updated.comment, "主线收束很稳")
        self.assertEqual(updated.book_status, "hiatus")

        response_delete = asyncio.run(wishlist_remove(wish.id))
        self.assertEqual(response_delete.status_code, 303)
        self.assertEqual(response_delete.headers.get("location"), "/tracker")
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
                tags="武侠, 玄幻",
                rating="4",
                read_status="unread",
                book_status="ongoing",
            )
        )

        request = Request({"type": "http", "method": "GET", "path": "/tracker", "headers": []})
        response = asyncio.run(wishlist_page(request))
        wishes = response.context.get("wishes", [])
        self.assertTrue(wishes)
        self.assertTrue(wishes[0].get("exists_in_library"))
        self.assertEqual(wishes[0].get("library_book_id"), book_id)

    def test_wishlist_create_dedupes_manual_identity(self) -> None:
        response_first = asyncio.run(
            wishlist_create(
                title="临渊行",
                author="宅猪",
                tags="仙侠",
                rating="4",
                review="初看不错",
                comment="开篇抓人",
                read_status="unread",
                book_status="ongoing",
            )
        )
        self.assertEqual(response_first.status_code, 303)

        response_second = asyncio.run(
            wishlist_create(
                title="临渊行",
                author="宅猪",
                tags="仙侠, 重读",
                rating="5",
                review="越看越好",
                comment="世界观展开很强",
                read_status="reading",
                book_status="completed",
            )
        )
        self.assertEqual(response_second.status_code, 303)

        wishes = list_wishes()
        self.assertEqual(len(wishes), 1)
        only = wishes[0]
        self.assertEqual(only.title, "临渊行")
        self.assertEqual(only.author, "宅猪")
        self.assertEqual(only.rating, 5)
        self.assertEqual(only.read_status, "reading")
        self.assertEqual(only.tags, ["仙侠", "重读"])
        self.assertEqual(only.review, "越看越好")
        self.assertEqual(only.comment, "世界观展开很强")
        self.assertEqual(only.book_status, "completed")

    def test_wishlist_update_merges_manual_identity_duplicate(self) -> None:
        asyncio.run(
            wishlist_create(
                title="A书",
                author="甲作者",
                tags="一刷",
                rating="3",
                read_status="unread",
                book_status="ongoing",
            )
        )
        asyncio.run(
            wishlist_create(
                title="B书",
                author="乙作者",
                tags="待看",
                rating="2",
                read_status="unread",
                book_status="ongoing",
            )
        )
        wishes = list_wishes()
        self.assertEqual(len(wishes), 2)
        book_a = next(item for item in wishes if item.title == "A书")
        book_b = next(item for item in wishes if item.title == "B书")

        response = asyncio.run(
            wishlist_update(
                book_b.id,
                title="A书",
                author="甲作者",
                tags="合并后",
                rating="5",
                review="合并成功",
                comment="应保留单条",
                read_status="read",
                book_status="completed",
            )
        )
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), "/tracker")

        merged_list = list_wishes()
        self.assertEqual(len(merged_list), 1)
        merged = merged_list[0]
        self.assertEqual(merged.id, book_a.id)
        self.assertEqual(merged.title, "A书")
        self.assertEqual(merged.author, "甲作者")
        self.assertEqual(merged.tags, ["合并后"])
        self.assertEqual(merged.rating, 5)
        self.assertEqual(merged.read_status, "read")
        self.assertEqual(merged.review, "合并成功")
        self.assertEqual(merged.comment, "应保留单条")
        self.assertEqual(merged.book_status, "completed")

    def test_wishlist_filters_and_stats(self) -> None:
        base = library_dir()
        book_id = "b" * 32
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
                title="诡秘之主",
                author="爱潜水的乌贼",
                tags="克苏鲁, 西幻",
                rating="5",
                read_status="read",
                book_status="completed",
            )
        )
        asyncio.run(
            wishlist_create(
                title="雪中悍刀行",
                author="烽火戏诸侯",
                tags="玄幻, 江湖",
                rating="4",
                read_status="reading",
                book_status="ongoing",
            )
        )
        asyncio.run(
            wishlist_create(
                title="大道争锋",
                author="误道者",
                tags="仙侠",
                rating="3",
                read_status="unread",
                book_status="hiatus",
            )
        )

        request = Request({"type": "http", "method": "GET", "path": "/tracker", "headers": []})
        response = asyncio.run(
            wishlist_page(
                request,
                q="江湖",
                read_filter="reading",
                library_filter="in",
                book_status_filter="ongoing",
            )
        )
        wishes = response.context.get("wishes", [])
        self.assertEqual(len(wishes), 1)
        self.assertEqual(wishes[0].get("title"), "雪中悍刀行")
        self.assertEqual(response.context.get("read_filter"), "reading")
        self.assertEqual(response.context.get("library_filter"), "in")
        self.assertEqual(response.context.get("book_status_filter"), "ongoing")
        self.assertEqual(
            response.context.get("current_url"),
            "/tracker?q=%E6%B1%9F%E6%B9%96&read_filter=reading&library_filter=in&book_status_filter=ongoing",
        )
        stats = response.context.get("stats", {})
        self.assertEqual(stats.get("total"), 3)
        self.assertEqual(stats.get("filtered"), 1)
        self.assertEqual(stats.get("read"), 1)
        self.assertEqual(stats.get("reading"), 1)
        self.assertEqual(stats.get("unread"), 1)

    def test_wishlist_next_redirect(self) -> None:
        target = "/tracker?read_filter=unread&library_filter=out"
        response = asyncio.run(
            wishlist_create(
                title="赤心巡天",
                author="情何以甚",
                tags="仙侠, 热血",
                rating="5",
                read_status="unread",
                book_status="ongoing",
                next=target,
            )
        )
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers.get("location"), target)

        wish = list_wishes()[0]
        response_update = asyncio.run(
            wishlist_update(
                wish.id,
                title=wish.title,
                author=wish.author or "",
                tags=", ".join(wish.tags),
                rating="",
                read_status="read",
                book_status="completed",
                next=target,
            )
        )
        self.assertEqual(response_update.status_code, 303)
        self.assertEqual(response_update.headers.get("location"), target)

        response_delete = asyncio.run(wishlist_remove(wish.id, next=target))
        self.assertEqual(response_delete.status_code, 303)
        self.assertEqual(response_delete.headers.get("location"), target)


if __name__ == "__main__":
    unittest.main()
