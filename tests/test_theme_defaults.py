import unittest

from bindery.models import Metadata
from bindery.web import DEFAULT_THEME_ID, KEEP_BOOK_THEME_ID, _build_metadata_from_epub, _effective_theme_id


class ThemeDefaultsTests(unittest.TestCase):
    def test_effective_theme_defaults_to_global(self) -> None:
        meta = Metadata(
            book_id="id",
            title="t",
            author=None,
            language="zh-CN",
            description=None,
            source_type="epub",
            theme_template=None,
            created_at="",
            updated_at="",
        )
        self.assertEqual(_effective_theme_id(meta), DEFAULT_THEME_ID)

    def test_effective_theme_can_keep_book_style_for_epub(self) -> None:
        meta = Metadata(
            book_id="id",
            title="t",
            author=None,
            language="zh-CN",
            description=None,
            source_type="epub",
            theme_template=KEEP_BOOK_THEME_ID,
            created_at="",
            updated_at="",
        )
        self.assertIsNone(_effective_theme_id(meta))

    def test_build_metadata_from_epub_defaults_theme(self) -> None:
        extracted = {
            "title": "书名",
            "author": "作者",
            "language": "zh-CN",
            "description": None,
            "series": None,
            "identifier": None,
            "publisher": None,
            "tags": [],
            "published": None,
            "isbn": None,
            "rating": None,
        }
        meta = _build_metadata_from_epub(
            "bookid",
            extracted,
            title="",
            author="",
            language="",
            description="",
            series="",
            identifier="",
            publisher="",
            tags="",
            published="",
            isbn="",
            rating="",
            theme_template="",
            custom_css="",
        )
        self.assertEqual(meta.theme_template, DEFAULT_THEME_ID)

    def test_build_metadata_from_epub_keeps_book_style_sentinel(self) -> None:
        extracted = {
            "title": "书名",
            "author": "作者",
            "language": "zh-CN",
            "description": None,
            "series": None,
            "identifier": None,
            "publisher": None,
            "tags": [],
            "published": None,
            "isbn": None,
            "rating": None,
        }
        meta = _build_metadata_from_epub(
            "bookid",
            extracted,
            title="",
            author="",
            language="",
            description="",
            series="",
            identifier="",
            publisher="",
            tags="",
            published="",
            isbn="",
            rating="",
            theme_template=KEEP_BOOK_THEME_ID,
            custom_css="",
        )
        self.assertEqual(meta.theme_template, KEEP_BOOK_THEME_ID)


if __name__ == "__main__":
    unittest.main()

