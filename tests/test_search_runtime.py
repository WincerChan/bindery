import unittest
from pathlib import Path
from unittest import mock

from bindery.epub import EpubSectionDocument
from bindery.web import _search_epub_hits


class SearchRuntimeTests(unittest.TestCase):
    def test_search_scans_documents_each_request(self) -> None:
        docs = [
            EpubSectionDocument(
                index=0,
                title="第一章",
                item_path="Text/ch1.xhtml",
                content=b"<html><body><p>alpha beta gamma</p></body></html>",
                media_type="application/xhtml+xml",
            )
        ]
        call_count = 0

        def fake_docs(_: Path) -> list[EpubSectionDocument]:
            nonlocal call_count
            call_count += 1
            return docs

        with mock.patch("bindery.web.list_epub_section_documents", side_effect=fake_docs):
            hits1, indexed1 = _search_epub_hits(Path("/tmp/demo.epub"), "beta", 20)
            hits2, indexed2 = _search_epub_hits(Path("/tmp/demo.epub"), "beta", 20)

        self.assertEqual(call_count, 2)
        self.assertEqual(indexed1, 1)
        self.assertEqual(indexed2, 1)
        self.assertEqual(len(hits1), 1)
        self.assertEqual(len(hits2), 1)
        self.assertEqual(hits1[0]["index"], 0)
        self.assertEqual(hits1[0]["title"], "第一章")

    def test_search_limit_only_applies_to_hits_not_indexed_count(self) -> None:
        docs = [
            EpubSectionDocument(
                index=0,
                title="A",
                item_path="Text/a.xhtml",
                content=b"<html><body>keyword here</body></html>",
                media_type="application/xhtml+xml",
            ),
            EpubSectionDocument(
                index=1,
                title="B",
                item_path="Text/b.xhtml",
                content=b"<html><body>keyword there</body></html>",
                media_type="application/xhtml+xml",
            ),
            EpubSectionDocument(
                index=2,
                title="C",
                item_path="Text/c.xhtml",
                content=b"<html><body>no match</body></html>",
                media_type="application/xhtml+xml",
            ),
        ]

        with mock.patch("bindery.web.list_epub_section_documents", return_value=docs):
            hits, indexed = _search_epub_hits(Path("/tmp/demo.epub"), "keyword", 1)

        self.assertEqual(len(hits), 1)
        self.assertEqual(indexed, 3)


if __name__ == "__main__":
    unittest.main()
