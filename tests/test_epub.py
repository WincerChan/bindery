import tempfile
import unittest
from pathlib import Path
import zipfile

from ebooklib import epub

from bindery.epub import build_epub, epub_base_href, extract_epub_metadata, list_epub_sections, update_epub_metadata
from bindery.epub import load_epub_item
from bindery.models import Book, Chapter, Metadata


class BuildEpubTests(unittest.TestCase):
    def test_epub_base_href_tracks_item_directory(self) -> None:
        self.assertEqual(epub_base_href("/book/abc/epub/", "chapter.xhtml"), "/book/abc/epub/")
        self.assertEqual(epub_base_href("/book/abc/epub", "chapter.xhtml"), "/book/abc/epub/")
        self.assertEqual(
            epub_base_href("/book/abc/epub/", "OEBPS/Text/ch1.xhtml"),
            "/book/abc/epub/OEBPS/Text/",
        )

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

    def test_build_epub_without_css_text_writes_empty_style_sheet(self) -> None:
        book = Book(title="测试书", author="作者", intro=None)
        chapter = Chapter(title="第一章", lines=["第一段文字。"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="empty-css-id",
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
            with zipfile.ZipFile(output_path, "r") as zf:
                style_candidates = [name for name in zf.namelist() if name.endswith("/style.css")]
                self.assertTrue(style_candidates)
                css_text = zf.read(style_candidates[0]).decode("utf-8")
                self.assertEqual(css_text, "")

    def test_build_epub_splits_chapter_stamp_and_main_title(self) -> None:
        book = Book(title="测试书", author="作者", intro=None)
        chapter = Chapter(title="第12章 风雪夜归人", lines=["第一段文字。"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="chapter-title-id",
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
            build_epub(book, meta, output_path, css_text="body { color: #111; }")
            with zipfile.ZipFile(output_path, "r") as zf:
                section_files = [name for name in zf.namelist() if name.endswith(".xhtml") and "section_" in name]
                self.assertTrue(section_files)
                content = zf.read(section_files[0]).decode("utf-8")
                self.assertIn('class="chapter-stamp">第12章</p>', content)
                self.assertIn('class="chapter-title">风雪夜归人</h1>', content)

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

    def test_update_epub_metadata_injects_bindery_css_overlay(self) -> None:
        book = Book(title="旧标题", author="旧作者", intro=None)
        chapter = Chapter(title="第一章", lines=["正文"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="update-css-id",
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

            update_epub_metadata(output_path, meta, css_text="body{margin-left:10px;}")

            with zipfile.ZipFile(output_path, "r") as zf:
                names = zf.namelist()
                self.assertTrue(any(name.endswith("/Styles/bindery.css") for name in names))
                self.assertFalse(any(name.endswith("/Text/bindery.css") for name in names))
                doc_names = [name for name in names if name.endswith(".xhtml") or name.endswith(".html")]
                self.assertTrue(doc_names)
                linked = 0
                for name in doc_names[:10]:
                    text = zf.read(name).decode("utf-8", errors="replace")
                    if "bindery.css" in text:
                        linked += 1
                self.assertGreater(linked, 0)

    def test_update_epub_metadata_places_bindery_css_under_styles_dir(self) -> None:
        meta = Metadata(
            book_id="update-css-dir-id",
            title="书",
            author="作者",
            language="zh-CN",
            description=None,
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            book = epub.EpubBook()
            book.set_identifier("urn:uuid:update-css-dir-id")
            book.set_title("书")
            book.set_language("zh-CN")

            doc = epub.EpubHtml(title="第一章", file_name="OEBPS/Text/ch1.xhtml", lang="zh-CN")
            doc.content = (
                "<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"zh-CN\">"
                "<head><meta charset=\"utf-8\" /><title>第一章</title></head>"
                "<body><p>正文</p></body></html>"
            )
            book.add_item(doc)
            book.toc = [doc]
            book.spine = ["nav", doc]
            book.add_item(epub.EpubNcx())
            book.add_item(epub.EpubNav())

            epub.write_epub(str(output_path), book, {"epub3_pages": False})

            update_epub_metadata(output_path, meta, css_text="body{margin-left:10px;}")

            with zipfile.ZipFile(output_path, "r") as zf:
                names = set(zf.namelist())
                self.assertIn("EPUB/OEBPS/Styles/bindery.css", names)
                self.assertNotIn("EPUB/OEBPS/Text/bindery.css", names)
                html_text = zf.read("EPUB/OEBPS/Text/ch1.xhtml").decode("utf-8", errors="replace")
                self.assertIn("../Styles/bindery.css", html_text)

    def test_load_epub_item_preserves_head_links(self) -> None:
        book = Book(title="旧标题", author="旧作者", intro=None)
        chapter = Chapter(title="第一章", lines=["正文"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="preview-id",
            title="旧标题",
            author="旧作者",
            language="zh-CN",
            description=None,
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            build_epub(book, meta, output_path)

            base_href = epub_base_href("/book/preview-id/epub/", "section_0001.xhtml")
            content, media_type = load_epub_item(output_path, "section_0001.xhtml", base_href)
            text = content.decode("utf-8", errors="replace")
            self.assertEqual(media_type, "text/html; charset=utf-8")
            self.assertIn("<base ", text)
            self.assertIn("style.css", text)


if __name__ == "__main__":
    unittest.main()
