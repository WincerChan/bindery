"""Rendered DOM regressions for the redesign's navigation and cover structure."""
import re
import unittest
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace

from jinja2 import Environment, FileSystemLoader, select_autoescape
from lxml import html

ROOT = Path(__file__).resolve().parent.parent


class AnchorParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.nested = False

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.nested |= self.depth > 0
            self.depth += 1

    def handle_endtag(self, tag):
        if tag == "a":
            self.depth -= 1


class EditorialUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=select_autoescape())

    def render_card(self, prefix="00", cover_url=""):
        book = dict(book_id=prefix + "a" * 30, title="长安的荔枝", author="马伯庸", cover_url=cover_url,
                    status_class="ok", read=True, source_type="txt", publisher="", published="", updated_at="")
        return self.env.get_template("partials/book_card.html").render(book=book, return_to="/?q=长安&page=2")

    def test_cover_detail_and_read_links_are_siblings(self):
        for cover_url in ("", "/book/cover?v=1"):
            with self.subTest(cover_url=cover_url):
                rendered = self.render_card(cover_url=cover_url)
                parser = AnchorParser()
                parser.feed(rendered)
                self.assertFalse(parser.nested)
                tree = html.fromstring(rendered)
                read = tree.xpath('//*[@data-book-hover-actions]')[0]
                detail = read.getparent().xpath('./a[@data-book-detail-link]')
                self.assertEqual(len(detail), 1)
                self.assertIn("return_to=", read.get("href"))
                self.assertEqual(len(tree.xpath('//*[@data-book-select]')), 2)
                self.assertEqual(len(tree.xpath('//form[@method="post"]/input[@name="next"]')), 1)

    def test_generated_covers_use_all_stable_tones_and_inner_layer(self):
        for prefix in ("00", "01", "02", "03", "04", "ff"):
            with self.subTest(prefix=prefix):
                tree = html.fromstring(self.render_card(prefix))
                covers = tree.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," cover-gen ")]')
                self.assertEqual(len(covers), 2)
                for cover in covers:
                    self.assertIn(f"cover-tone-{int(prefix, 16) % 5}", cover.get("class").split())
                    inner = cover.xpath('./div[@class="cover-gen-inner"]')
                    self.assertEqual(len(inner), 1)
                    self.assertIn("长安的荔枝", inner[0].text_content())
                self.assertEqual(tree.xpath('//*[@class="cover-gen-char"]/text()'), ["长"])

    def test_container_query_padding_stays_on_inner_layer(self):
        css = (ROOT / "static" / "tailwind.css").read_text()
        container = re.search(r"\.cover-gen \{([^}]+)\}", css)[1]
        inner = re.search(r"\.cover-gen-inner \{([^}]+)\}", css)[1]
        self.assertIn("container-type: inline-size", container)
        self.assertNotIn("padding", container)
        self.assertIn("position: absolute", inner)
        self.assertIn("inset: 0", inner)
        self.assertIn("padding: 11cqi 10cqi 9cqi", inner)

    def test_real_covers_remain_lazy_in_both_views(self):
        tree = html.fromstring(self.render_card(cover_url="/book/cover?v=1"))
        images = tree.xpath('//img[@data-cover-src]')
        self.assertEqual(len(images), 2)
        for image in images:
            self.assertIsNone(image.get("src"))
            self.assertEqual(image.get("loading"), "lazy")
            self.assertEqual(image.get("data-cover-src"), "/book/cover?v=1")

    def test_more_sheet_keeps_logout_post_and_existing_destinations(self):
        rendered = self.env.get_template("base.html").render(request=SimpleNamespace(url=SimpleNamespace(path="/rules")))
        tree = html.fromstring(rendered)
        sheet = tree.xpath('//*[@id="more-sheet"]')[0]
        self.assertEqual(sheet.get("role"), "dialog")
        self.assertEqual(sheet.xpath('./a/@href'), ["/rules", "/archive", "/security"])
        self.assertEqual(sheet.xpath('./form[@action="/logout"]/@method'), ["post"])
        tabs = tree.xpath('//nav[@aria-label="手机导航"]')[0]
        self.assertEqual(len(tabs.xpath('./a | ./button')), 5)
        self.assertEqual(tabs.xpath('./button/@aria-controls'), ["more-sheet"])

    def test_floating_bulk_forms_keep_their_submission_targets(self):
        rendered = self.env.get_template("index.html").render(
            request=SimpleNamespace(url=SimpleNamespace(path="/")), books=[], total_books=0, page=1,
            total_pages=1, per_page=32, q="", sort="updated", read_filter="unread", has_prev=False,
            has_next=False, prev_page=1, next_page=1, return_to="/",
        )
        tree = html.fromstring(rendered)
        bar = tree.xpath('//*[@data-bulk-actions]')[0]
        self.assertEqual(bar.xpath('.//form/@action'), ["/books/download", "/books/archive"])
        self.assertEqual(bar.xpath('.//form/@method'), ["post", "post"])
        self.assertEqual(bar.xpath('.//form[@id="bulk-download-form"]/@target'), ["bulk-download-target"])
        self.assertEqual(len(bar.xpath('.//*[@data-book-ids]')), 2)
        self.assertEqual(len(bar.xpath('.//*[@data-bulk-done]')), 1)
        self.assertIn("0 册 · 仅未读", tree.xpath('//*[@data-library-count]')[0].text_content())

    def test_empty_archive_omits_bulk_controls_and_table_header(self):
        rendered = self.env.get_template("archive.html").render(
            request=SimpleNamespace(url=SimpleNamespace(path="/archive")), books=[],
        )
        tree = html.fromstring(rendered)
        self.assertFalse(tree.xpath('//*[@data-archive-select-all or @data-archive-bulk-bar]'))
        self.assertFalse(tree.xpath('//*[@id="archive-bulk-delete-form"]'))
        self.assertFalse(tree.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," archive-row ")]'))
        self.assertIn("归档为空。", tree.xpath('//main')[0].text_content())

    def test_populated_archive_keeps_selection_and_submission_hooks(self):
        book = dict(book_id="00" + "a" * 30, title="长安的荔枝", author="马伯庸",
                    source_type="txt", publisher="", published="", updated_at="2026-10-18T16:34:03")
        rendered = self.env.get_template("archive.html").render(
            request=SimpleNamespace(url=SimpleNamespace(path="/archive")), books=[book],
        )
        tree = html.fromstring(rendered)
        for hook in ("data-archive-select-all", "data-archive-bulk-bar", "data-archive-select",
                     "data-archive-clear", "data-archive-book-ids", "data-archive-bulk-delete"):
            self.assertEqual(len(tree.xpath(f'//*[@{hook}]')), 1)
        self.assertEqual(tree.xpath('//main//form/@action'), [
            "/archive/delete-bulk", f'/book/{book["book_id"]}/restore', f'/book/{book["book_id"]}/delete',
        ])
        self.assertEqual(tree.xpath('//main//form/@method'), ["post"] * 3)
        self.assertIn("书名 / 作者", tree.xpath('//main')[0].text_content())

    def test_detail_dates_keep_full_value_with_short_phone_display(self):
        book = dict(book_id="00" + "a" * 30, title="长安的荔枝", author="马伯庸", rating=None,
                    read=False, tags=[], source_type="txt", created_at="2026-10-18T16:34:03",
                    updated_at="2026-10-19T08:09:10")
        rendered = self.env.get_template("partials/meta_view.html").render(
            book=book, book_id=book["book_id"], return_to="/", return_to_query="",
        )
        tree = html.fromstring(rendered)
        for label, field in (("入库时间", "created_at"), ("更新时间", "updated_at")):
            time = tree.xpath(f'//dt[text()="{label}"]/following-sibling::dd/time')[0]
            self.assertEqual(time.get("datetime"), book[field])
            self.assertEqual(time.get("title"), book[field].replace("T", " "))
            self.assertEqual(time.xpath('./span[@class="md:hidden"]/text()'), [book[field][:16].replace("T", " ")])
            self.assertEqual(time.xpath('./span[@class="hidden md:inline"]/text()'), [book[field].replace("T", " ")])


if __name__ == "__main__":
    unittest.main()
