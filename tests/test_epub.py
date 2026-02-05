import tempfile
import unittest
from pathlib import Path
import zipfile

from bindery.epub import build_epub, extract_epub_metadata, list_epub_sections, update_epub_metadata
from bindery.models import Book, Chapter, Metadata


class BuildEpubTests(unittest.TestCase):
    def test_build_epub_creates_file(self) -> None:
        book = Book(title="测试书", author="作者", intro=None)
        chapter = Chapter(title="第一章", lines=["第一段文字。"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="test-id",
            title="测试书",
            author="作者",
            language="zh-CN",
            description=None,
            publisher=None,
            tags=[],
            published=None,
            isbn=None,
            rating=None,
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            build_epub(book, meta, output_path)
            self.assertTrue(output_path.exists())
            self.assertGreater(output_path.stat().st_size, 0)
            with zipfile.ZipFile(output_path, "r") as zf:
                section_files = [name for name in zf.namelist() if name.endswith(".xhtml") and "section_" in name]
                self.assertTrue(section_files)
                content = zf.read(section_files[0]).decode("utf-8")
                self.assertIn("第一章", content)

    def test_extract_epub_metadata(self) -> None:
        book = Book(title="元数据书", author="作者", intro=None)
        chapter = Chapter(title="第一章", lines=["正文"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="meta-id",
            title="元数据书",
            author="作者",
            language="zh-CN",
            description="简介",
            series="系列",
            identifier="ID-123",
            publisher="出版社",
            tags=["标签1", "标签2"],
            published="2024-01-01",
            isbn="9781234567890",
            rating=4,
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            build_epub(book, meta, output_path)
            extracted = extract_epub_metadata(output_path, "fallback")
            self.assertEqual(extracted["title"], "元数据书")
            self.assertEqual(extracted["author"], "作者")
            self.assertEqual(extracted["language"], "zh-CN")
            self.assertEqual(extracted["description"], "简介")
            self.assertEqual(extracted["series"], "系列")
            self.assertEqual(extracted["identifier"], "ID-123")
            self.assertEqual(extracted["publisher"], "出版社")
            self.assertIn("标签1", extracted["tags"])
            self.assertEqual(extracted["published"], "2024-01-01")
            self.assertEqual(extracted["isbn"], "9781234567890")
            self.assertEqual(extracted["rating"], 4)

    def test_list_epub_sections(self) -> None:
        book = Book(title="章节书", author="作者", intro="简介")
        chapter = Chapter(title="第一章", lines=["正文"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="section-id",
            title="章节书",
            author="作者",
            language="zh-CN",
            description=None,
            publisher=None,
            tags=[],
            published=None,
            isbn=None,
            rating=None,
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            build_epub(book, meta, output_path)
            sections = list_epub_sections(output_path)
            self.assertTrue(sections)
            self.assertTrue(sections[0].title)

    def test_update_epub_metadata(self) -> None:
        book = Book(title="旧标题", author="旧作者", intro=None)
        chapter = Chapter(title="第一章", lines=["正文"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="update-id",
            title="旧标题",
            author="旧作者",
            language="zh-CN",
            description=None,
            publisher=None,
            tags=[],
            published=None,
            isbn=None,
            rating=None,
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            build_epub(book, meta, output_path)
            new_meta = Metadata(
                book_id="update-id",
                title="新标题",
                author="新作者",
                language="zh-CN",
                description="新简介",
                publisher="新出版社",
                tags=["新标签"],
                published="2025-01-01",
                isbn="9780000000000",
                rating=5,
                created_at="",
                updated_at="",
            )
            update_epub_metadata(output_path, new_meta)
            extracted = extract_epub_metadata(output_path, "fallback")
            self.assertEqual(extracted["title"], "新标题")
            self.assertEqual(extracted["author"], "新作者")
            self.assertEqual(extracted["description"], "新简介")


if __name__ == "__main__":
    unittest.main()
