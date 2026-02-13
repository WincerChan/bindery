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

    def test_parse_douban_subject_html_publisher_fallback_keeps_spaces(self) -> None:
        html = """
        <html>
          <body>
            <div id="info">
              <span class="pl">出版社:</span> Random House Children's Books
              <br />
              <span class="pl">出版年:</span> 2010-01
            </div>
          </body>
        </html>
        """
        metadata = parse_douban_subject_html(html)
        self.assertEqual(metadata.publisher, "Random House Children's Books")

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

    def test_parse_amazon_product_html_falls_back_without_ld_json(self) -> None:
        html = """
        <html>
          <head>
            <meta name="title" content="Amazon.com: Pirates Past Noon: 9780679824251: Osborne, Mary Pope: Books" />
          </head>
          <body>
            <span id="productTitle">Pirates Past Noon (Magic Tree House, No. 4)</span>
            <div id="bylineInfo">
              <a>Mary Pope Osborne</a>
              <span class="contribution"><span>(作者)</span></span>
              <a>Sal Murdocca</a>
              <span class="contribution"><span>(插图作者)</span></span>
            </div>
            <div id="bookDescription_feature_div">
              <span class="a-expander-partial-collapse-content">
                Jack and Annie are in deep trouble when the Magic Tree House whisks them back to the days of
                desert islands, secret maps, hidden gold, and ruthless pirates.
              </span>
            </div>

            <div id="rpi-attribute-book_details-publisher">
              <div class="rpi-attribute-value"><span>Random House Children's Books</span></div>
            </div>
            <div id="rpi-attribute-book_details-publication_date">
              <div class="rpi-attribute-value"><span>1994-03-08</span></div>
            </div>
            <div id="rpi-attribute-book_details-language">
              <div class="rpi-attribute-value"><span>English</span></div>
            </div>
            <div id="rpi-attribute-book_details-isbn13">
              <div class="rpi-attribute-value"><span>978-0679824251</span></div>
            </div>
          </body>
        </html>
        """
        metadata = parse_amazon_product_html(html)
        self.assertEqual(metadata.title, "Pirates Past Noon (Magic Tree House, No. 4)")
        self.assertEqual(metadata.author, "Mary Pope Osborne, Sal Murdocca")
        self.assertEqual(metadata.publisher, "Random House Children's Books")
        self.assertEqual(metadata.language, "English")
        self.assertEqual(metadata.published, "1994-03-08")
        self.assertEqual(metadata.isbn, "978-0679824251")
        self.assertIn("Magic Tree House", metadata.description or "")

    def test_lookup_verbose_uses_douban_only(self) -> None:
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
            ) as amazon_mock,
        ):
            best, errors, attempts = lookup_book_metadata_verbose("三体")

        amazon_mock.assert_not_called()
        self.assertIsNotNone(best)
        self.assertEqual(best.source, "douban")
        self.assertEqual(errors, [])
        self.assertEqual(len(attempts), 1)
        self.assertEqual({item["source"] for item in attempts}, {"douban"})
        selected = [item for item in attempts if item["selected"]]
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["source"], "douban")

    def test_lookup_verbose_keeps_source_error(self) -> None:
        with (
            patch("bindery.metadata_lookup._lookup_douban", side_effect=RuntimeError("blocked")),
            patch(
                "bindery.metadata_lookup._lookup_amazon",
                return_value=LookupMetadata(source="amazon", title="Dune"),
            ) as amazon_mock,
        ):
            best, errors, attempts = lookup_book_metadata_verbose("Dune")

        amazon_mock.assert_not_called()
        self.assertIsNone(best)
        self.assertEqual(len(errors), 1)
        self.assertIn("douban: blocked", errors[0])
        self.assertEqual(len(attempts), 1)
        douban_attempt = attempts[0]
        self.assertEqual(douban_attempt["source"], "douban")
        self.assertFalse(douban_attempt["ok"])
        self.assertEqual(douban_attempt["error"], "blocked")


if __name__ == "__main__":
    unittest.main()
