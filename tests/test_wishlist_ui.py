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
        self.assertIn("data-open-edit-modal", tpl)
        self.assertIn("data-edit-modal", tpl)
        self.assertIn("data-edit-form", tpl)
        self.assertIn("No books match your filters.", tpl)
        self.assertIn('`/tracker/${wishId}/update`', tpl)
        self.assertIn('/tracker/{{ wish.id }}/delete', tpl)
        self.assertIn("编辑追踪", tpl)
        self.assertIn("书名", tpl)
        self.assertIn("作者", tpl)
        self.assertIn("状态", tpl)
        self.assertIn("评分", tpl)
        self.assertIn("阅读", tpl)
        self.assertIn("更新时间", tpl)
        self.assertIn('href="/book/{{ wish.library_book_id }}?return_to={{ current_url|urlencode }}"', tpl)
        self.assertIn('aria-label="查看详情"', tpl)
        self.assertIn("M7 17L17 7", tpl)
        self.assertIn("已入库条目的书名/作者由书库元数据维护", tpl)
        self.assertIn("第 {{ page }} / {{ total_pages }} 页", tpl)
        self.assertIn("上一页", tpl)
        self.assertIn("下一页", tpl)
        self.assertIn("更新中", tpl)
        self.assertIn("已断更", tpl)
        self.assertIn("已完结", tpl)


if __name__ == "__main__":
    unittest.main()
