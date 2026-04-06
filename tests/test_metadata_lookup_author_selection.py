import importlib
import sys
import types
import unittest
from unittest.mock import patch


def _install_lxml_stub() -> None:
    if "lxml" in sys.modules and "lxml.etree" in sys.modules and "lxml.html" in sys.modules:
        return

    lxml_module = types.ModuleType("lxml")
    etree_module = types.ModuleType("lxml.etree")
    html_module = types.ModuleType("lxml.html")

    class ParserError(ValueError):
        pass

    etree_module.ParserError = ParserError
    html_module.fromstring = lambda _html: None

    lxml_module.etree = etree_module
    lxml_module.html = html_module

    sys.modules.setdefault("lxml", lxml_module)
    sys.modules.setdefault("lxml.etree", etree_module)
    sys.modules.setdefault("lxml.html", html_module)


_install_lxml_stub()
metadata_lookup = importlib.import_module("bindery.metadata_lookup")
LookupMetadata = metadata_lookup.LookupMetadata
lookup_book_metadata_verbose = metadata_lookup.lookup_book_metadata_verbose


class MetadataLookupAuthorSelectionTests(unittest.TestCase):
    def test_prefers_matching_author_for_same_title(self) -> None:
        suggest_payload = [
            {"id": "1", "title": "三体", "author_name": "张三", "year": "2001"},
            {"id": "2", "title": "三体", "author_name": "刘慈欣", "year": "2008"},
        ]

        with (
            patch.object(metadata_lookup, "_fetch_json", return_value=suggest_payload),
            patch.object(metadata_lookup, "_fetch_text", return_value="subject-2") as fetch_text,
            patch.object(
                metadata_lookup,
                "parse_douban_subject_html",
                return_value=LookupMetadata(
                    source="douban",
                    title="三体",
                    author="刘慈欣",
                    description="科幻小说",
                    published="2008-01-01",
                ),
            ),
        ):
            best, errors, attempts = lookup_book_metadata_verbose("三体", author="刘慈欣")

        self.assertIsNotNone(best)
        assert best is not None
        self.assertEqual(best.title, "三体")
        self.assertEqual(best.author, "刘慈欣")
        self.assertEqual(best.published, "2008-01-01")
        self.assertEqual(errors, [])
        self.assertEqual(len(attempts), 1)
        self.assertTrue(attempts[0]["selected"])
        fetch_text.assert_called_once_with("https://book.douban.com/subject/2/", timeout=8.0)

    def test_rejects_same_title_when_author_conflicts(self) -> None:
        suggest_payload = [
            {"id": "1", "title": "三体", "author_name": "张三", "year": "2001"},
            {"id": "2", "title": "三体", "author_name": "李四", "year": "2005"},
        ]

        with (
            patch.object(metadata_lookup, "_fetch_json", return_value=suggest_payload),
            patch.object(metadata_lookup, "_fetch_text") as fetch_text,
        ):
            best, errors, attempts = lookup_book_metadata_verbose("三体", author="刘慈欣")

        self.assertIsNone(best)
        self.assertEqual(len(errors), 1)
        self.assertIn("作者匹配", errors[0])
        self.assertEqual(len(attempts), 1)
        self.assertFalse(attempts[0]["ok"])
        self.assertIn("作者匹配", attempts[0]["error"])
        fetch_text.assert_not_called()


if __name__ == "__main__":
    unittest.main()
