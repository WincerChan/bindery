import unittest

from bindery.web import _lookup_result_view


class MetadataFetchResultTests(unittest.TestCase):
    def test_lookup_result_separates_source_and_applied_cover_url(self) -> None:
        draft_book = {
            "title": "示例书",
            "author": "作者",
            "language": "zh-CN",
            "publisher": "出版社",
            "published": "2024-08-15",
            "isbn": "1234567890",
            "cover_fetch_url": "https://example.com/applied.jpg",
            "tags": ["小说"],
            "description": "简介",
        }
        result = _lookup_result_view(
            "示例书",
            "豆瓣",
            draft_book,
            [],
            source_cover_url="https://example.com/source.jpg",
        )
        self.assertEqual(result["cover_url"], "https://example.com/source.jpg")
        self.assertEqual(result["applied_cover_url"], "https://example.com/applied.jpg")


if __name__ == "__main__":
    unittest.main()
