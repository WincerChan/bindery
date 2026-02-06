import unittest
from unittest.mock import patch

from bindery.metadata_lookup import (
    LookupMetadata,
    lookup_book_metadata_verbose,
    parse_amazon_product_html,
    parse_douban_subject_html,
)


class MetadataLookupTests(unittest.TestCase):
    def test_parse_douban_subject_html_from_ld_json(self) -> None:
        html = """
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Book",
                "name": "The Three-Body Problem",
                "author": [{"@type": "Person", "name": "Cixin Liu"}],
                "description": "A sci-fi classic.",
                "publisher": {"@type": "Organization", "name": "Chongqing Press"},
                "datePublished": "2008-01-01",
                "isbn": "9787536692930",
                "inLanguage": "zh-CN",
                "keywords": "Sci-Fi, Space"
              }
            </script>
          </head>
        </html>
        """
        metadata = parse_douban_subject_html(html)
        self.assertEqual(metadata.source, "douban")
        self.assertEqual(metadata.title, "The Three-Body Problem")
        self.assertEqual(metadata.author, "Cixin Liu")
        self.assertEqual(metadata.publisher, "Chongqing Press")
        self.assertEqual(metadata.published, "2008-01-01")
        self.assertEqual(metadata.isbn, "9787536692930")
        self.assertIn("Sci-Fi", metadata.tags)

    def test_parse_douban_subject_html_prefers_a_tag_text(self) -> None:
        html = """
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Book",
                "name": "示例书",
                "keywords": "不会采用, 关键词"
              }
            </script>
          </head>
          <body>
            <a class="tag">小说</a>
            <a class="tag">悬疑</a>
            <script>
              criteria = '7:文学|7:惊悚|3:/subject/123/';
            </script>
          </body>
        </html>
        """
        metadata = parse_douban_subject_html(html)
        self.assertEqual(metadata.tags, ["小说", "悬疑"])

    def test_parse_douban_subject_html_falls_back_to_criteria(self) -> None:
        html = """
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Book",
                "name": "示例书",
                "keywords": "不会采用, 关键词"
              }
            </script>
          </head>
          <body>
            <script>
              criteria = '7:小说|7:文学|7:悬疑|3:/subject/36397240/';
            </script>
          </body>
        </html>
        """
        metadata = parse_douban_subject_html(html)
        self.assertEqual(metadata.tags, ["小说", "文学", "悬疑"])

    def test_parse_douban_subject_html_prefers_last_intro_block(self) -> None:
        html = """
        <html>
          <body>
            <div id="link-report">
              <div class="intro">
                <p>短简介。</p>
              </div>
              <div class="intro">
                <p>完整简介第一段。</p>
                <p>完整简介第二段。<br>换行继续。</p>
              </div>
            </div>
          </body>
        </html>
        """
        metadata = parse_douban_subject_html(html)
        self.assertEqual(metadata.description, "完整简介第一段。\n\n完整简介第二段。\n换行继续。")

    def test_parse_douban_subject_html_prefers_nbg_cover_href(self) -> None:
        html = """
        <html>
          <head>
            <meta property="og:image" content="https://img9.doubanio.com/view/subject/l/public/s1234567.jpg" />
          </head>
          <body>
            <a class="nbg" href="https://img3.doubanio.com/view/subject/l/public/s7654321.jpg">cover</a>
          </body>
        </html>
        """
        metadata = parse_douban_subject_html(html)
        self.assertEqual(
            metadata.cover_url,
            "https://img3.doubanio.com/view/subject/l/public/s7654321.jpg",
        )

    def test_parse_douban_subject_html_falls_back_to_og_image(self) -> None:
        html = """
        <html>
          <head>
            <meta property="og:image" content="https://img9.doubanio.com/view/subject/l/public/s1234567.jpg" />
          </head>
          <body></body>
        </html>
        """
        metadata = parse_douban_subject_html(html)
        self.assertEqual(
            metadata.cover_url,
            "https://img9.doubanio.com/view/subject/l/public/s1234567.jpg",
        )

    def test_parse_amazon_product_html_from_ld_json(self) -> None:
        html = """
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Book",
                "name": "Dune",
                "author": {"@type": "Person", "name": "Frank Herbert"},
                "description": "Epic science fiction novel.",
                "datePublished": "1965-08-01",
                "isbn": "9780441172719",
                "inLanguage": "en",
                "keywords": "science fiction, desert"
              }
            </script>
          </head>
          <body>
            Publisher: Ace
          </body>
        </html>
        """
        metadata = parse_amazon_product_html(html)
        self.assertEqual(metadata.source, "amazon")
        self.assertEqual(metadata.title, "Dune")
        self.assertEqual(metadata.author, "Frank Herbert")
        self.assertEqual(metadata.published, "1965-08-01")
        self.assertEqual(metadata.isbn, "9780441172719")
        self.assertIn("science fiction", metadata.tags)

    def test_lookup_verbose_reports_both_sources(self) -> None:
        with (
            patch(
                "bindery.metadata_lookup._lookup_douban",
                return_value=LookupMetadata(source="douban", title="三体"),
            ),
            patch(
                "bindery.metadata_lookup._lookup_amazon",
                return_value=LookupMetadata(
                    source="amazon",
                    title="三体",
                    author="Cixin Liu",
                    description="Science fiction novel",
                    publisher="Tor",
                    isbn="9780765382030",
                ),
            ),
        ):
            best, errors, attempts = lookup_book_metadata_verbose("三体")

        self.assertIsNotNone(best)
        self.assertEqual(best.source, "amazon")
        self.assertEqual(errors, [])
        self.assertEqual(len(attempts), 2)
        self.assertEqual({item["source"] for item in attempts}, {"douban", "amazon"})
        selected = [item for item in attempts if item["selected"]]
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["source"], "amazon")

    def test_lookup_verbose_keeps_source_error(self) -> None:
        with (
            patch("bindery.metadata_lookup._lookup_douban", side_effect=RuntimeError("blocked")),
            patch(
                "bindery.metadata_lookup._lookup_amazon",
                return_value=LookupMetadata(source="amazon", title="Dune"),
            ),
        ):
            best, errors, attempts = lookup_book_metadata_verbose("Dune")

        self.assertIsNotNone(best)
        self.assertEqual(best.source, "amazon")
        self.assertEqual(len(errors), 1)
        self.assertIn("douban: blocked", errors[0])
        douban_attempt = next(item for item in attempts if item["source"] == "douban")
        self.assertFalse(douban_attempt["ok"])
        self.assertEqual(douban_attempt["error"], "blocked")


if __name__ == "__main__":
    unittest.main()
