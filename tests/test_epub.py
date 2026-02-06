import tempfile
import unittest
from pathlib import Path
import zipfile

from ebooklib import epub

from bindery.epub import (
    build_epub,
    epub_base_href,
    extract_epub_metadata,
    list_epub_sections,
    strip_webp_assets_and_refs,
    update_epub_metadata,
)
from bindery.epub import load_epub_item
from bindery.models import Book, Chapter, Metadata


class BuildEpubTests(unittest.TestCase):
    def _create_external_epub_with_inline_style(
        self,
        output_path: Path,
        *,
        book_id: str,
        title: str = "旧书名",
        author: str = "旧作者",
    ) -> None:
        chapter_html = (
            "<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"zh-CN\">"
            "<head><meta charset=\"utf-8\" /><title>第一章</title><style>p{color:#d00;}</style></head>"
            "<body><p>正文</p></body></html>"
        )
        with zipfile.ZipFile(output_path, "w") as zf:
            zf.writestr("mimetype", b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
            zf.writestr(
                "META-INF/container.xml",
                (
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
                    "<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">"
                    "<rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>"
                    "</rootfiles></container>"
                ),
            )
            zf.writestr(
                "OEBPS/content.opf",
                (
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                    "<package xmlns=\"http://www.idpf.org/2007/opf\" unique-identifier=\"BookId\" version=\"3.0\">"
                    "<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">"
                    f"<dc:identifier id=\"BookId\">urn:uuid:{book_id}</dc:identifier>"
                    f"<dc:title>{title}</dc:title>"
                    "<dc:language>zh-CN</dc:language>"
                    f"<dc:creator>{author}</dc:creator>"
                    "</metadata>"
                    "<manifest>"
                    "<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>"
                    "<item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>"
                    "<item id=\"c1\" href=\"Text/ch1.xhtml\" media-type=\"application/xhtml+xml\"/>"
                    "</manifest>"
                    "<spine toc=\"ncx\"><itemref idref=\"c1\"/></spine>"
                    "</package>"
                ),
            )
            zf.writestr(
                "OEBPS/nav.xhtml",
                (
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                    "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>nav</title></head><body>"
                    "<nav epub:type=\"toc\" xmlns:epub=\"http://www.idpf.org/2007/ops\"><ol>"
                    "<li><a href=\"Text/ch1.xhtml\">第一章</a></li>"
                    "</ol></nav></body></html>"
                ),
            )
            zf.writestr(
                "OEBPS/toc.ncx",
                (
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                    "<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\">"
                    "<head></head><docTitle><text>旧书名</text></docTitle><navMap>"
                    "<navPoint id=\"navPoint-1\" playOrder=\"1\"><navLabel><text>第一章</text></navLabel>"
                    "<content src=\"Text/ch1.xhtml\"/></navPoint></navMap></ncx>"
                ),
            )
            zf.writestr("OEBPS/Text/ch1.xhtml", chapter_html)

    def _read_any_chapter_html(self, output_path: Path) -> str:
        with zipfile.ZipFile(output_path, "r") as zf:
            names = zf.namelist()
            for candidate in ("OEBPS/Text/ch1.xhtml", "EPUB/OEBPS/Text/ch1.xhtml", "EPUB/Text/ch1.xhtml"):
                if candidate in names:
                    return zf.read(candidate).decode("utf-8", errors="replace")
        raise AssertionError("chapter html not found")

    def _create_external_epub_with_linked_style(self, output_path: Path, *, book_id: str) -> None:
        chapter_html = (
            "<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"zh-CN\">"
            "<head>"
            "<meta charset=\"utf-8\" />"
            "<title>第一章</title>"
            "<link rel=\"stylesheet\" type=\"text/css\" href=\"../Styles/book.css\" />"
            "<style>p{color:#d00;}</style>"
            "</head>"
            "<body><p>正文</p></body></html>"
        )
        with zipfile.ZipFile(output_path, "w") as zf:
            zf.writestr("mimetype", b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
            zf.writestr(
                "META-INF/container.xml",
                (
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
                    "<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">"
                    "<rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>"
                    "</rootfiles></container>"
                ),
            )
            zf.writestr(
                "OEBPS/content.opf",
                (
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                    "<package xmlns=\"http://www.idpf.org/2007/opf\" unique-identifier=\"BookId\" version=\"3.0\">"
                    "<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">"
                    f"<dc:identifier id=\"BookId\">urn:uuid:{book_id}</dc:identifier>"
                    "<dc:title>旧书名</dc:title>"
                    "<dc:language>zh-CN</dc:language>"
                    "<dc:creator>旧作者</dc:creator>"
                    "</metadata>"
                    "<manifest>"
                    "<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>"
                    "<item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>"
                    "<item id=\"c1\" href=\"Text/ch1.xhtml\" media-type=\"application/xhtml+xml\"/>"
                    "<item id=\"s1\" href=\"Styles/book.css\" media-type=\"text/css\"/>"
                    "</manifest>"
                    "<spine toc=\"ncx\"><itemref idref=\"c1\"/></spine>"
                    "</package>"
                ),
            )
            zf.writestr(
                "OEBPS/nav.xhtml",
                (
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                    "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>nav</title></head><body>"
                    "<nav epub:type=\"toc\" xmlns:epub=\"http://www.idpf.org/2007/ops\"><ol>"
                    "<li><a href=\"Text/ch1.xhtml\">第一章</a></li>"
                    "</ol></nav></body></html>"
                ),
            )
            zf.writestr(
                "OEBPS/toc.ncx",
                (
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                    "<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\">"
                    "<head></head><docTitle><text>旧书名</text></docTitle><navMap>"
                    "<navPoint id=\"navPoint-1\" playOrder=\"1\"><navLabel><text>第一章</text></navLabel>"
                    "<content src=\"Text/ch1.xhtml\"/></navPoint></navMap></ncx>"
                ),
            )
            zf.writestr("OEBPS/Styles/book.css", "body{font-family:serif;}")
            zf.writestr("OEBPS/Text/ch1.xhtml", chapter_html)

    def _create_external_epub_with_webp_refs(self, output_path: Path, *, book_id: str) -> None:
        chapter_html = (
            "<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"zh-CN\">"
            "<head><meta charset=\"utf-8\" /><title>第一章</title></head>"
            "<body>"
            "<img src=\"../Images/a.webp\" alt=\"a\" />"
            "<picture><source srcset=\"../Images/b.webp\" type=\"image/webp\" /><img src=\"../Images/fallback.jpg\" /></picture>"
            "<a href=\"../Images/c.webp\">下载</a>"
            "</body></html>"
        )
        with zipfile.ZipFile(output_path, "w") as zf:
            zf.writestr("mimetype", b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
            zf.writestr(
                "META-INF/container.xml",
                (
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
                    "<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">"
                    "<rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>"
                    "</rootfiles></container>"
                ),
            )
            zf.writestr(
                "OEBPS/content.opf",
                (
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                    "<package xmlns=\"http://www.idpf.org/2007/opf\" unique-identifier=\"BookId\" version=\"3.0\">"
                    "<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">"
                    f"<dc:identifier id=\"BookId\">urn:uuid:{book_id}</dc:identifier>"
                    "<dc:title>旧书名</dc:title>"
                    "<dc:language>zh-CN</dc:language>"
                    "<dc:creator>旧作者</dc:creator>"
                    "</metadata>"
                    "<manifest>"
                    "<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>"
                    "<item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>"
                    "<item id=\"c1\" href=\"Text/ch1.xhtml\" media-type=\"application/xhtml+xml\"/>"
                    "<item id=\"w1\" href=\"Images/a.webp\" media-type=\"image/webp\"/>"
                    "<item id=\"w2\" href=\"Images/b.webp\" media-type=\"image/webp\"/>"
                    "<item id=\"w3\" href=\"Images/c.webp\" media-type=\"image/webp\"/>"
                    "<item id=\"j1\" href=\"Images/fallback.jpg\" media-type=\"image/jpeg\"/>"
                    "</manifest>"
                    "<spine toc=\"ncx\"><itemref idref=\"c1\"/></spine>"
                    "</package>"
                ),
            )
            zf.writestr(
                "OEBPS/nav.xhtml",
                (
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                    "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>nav</title></head><body>"
                    "<nav epub:type=\"toc\" xmlns:epub=\"http://www.idpf.org/2007/ops\"><ol>"
                    "<li><a href=\"Text/ch1.xhtml\">第一章</a></li>"
                    "</ol></nav></body></html>"
                ),
            )
            zf.writestr(
                "OEBPS/toc.ncx",
                (
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                    "<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\">"
                    "<head></head><docTitle><text>旧书名</text></docTitle><navMap>"
                    "<navPoint id=\"navPoint-1\" playOrder=\"1\"><navLabel><text>第一章</text></navLabel>"
                    "<content src=\"Text/ch1.xhtml\"/></navPoint></navMap></ncx>"
                ),
            )
            zf.writestr("OEBPS/Text/ch1.xhtml", chapter_html)
            zf.writestr("OEBPS/Images/a.webp", b"RIFF....WEBP")
            zf.writestr("OEBPS/Images/b.webp", b"RIFF....WEBP")
            zf.writestr("OEBPS/Images/c.webp", b"RIFF....WEBP")
            zf.writestr("OEBPS/Images/fallback.jpg", b"\xff\xd8\xff\xd9")

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

    def test_list_epub_sections_keeps_full_chapter_title_from_toc(self) -> None:
        book = Book(title="测试书", author="作者", intro=None)
        chapter = Chapter(title="第12章 风雪夜归人", lines=["第一段文字。"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="chapter-toc-title-id",
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
            build_epub(book, meta, output_path, css_text="")
            sections = list_epub_sections(output_path)
            self.assertTrue(sections)
            self.assertEqual(sections[0].title, "第12章 风雪夜归人")

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

    def test_update_epub_metadata_repairs_noncanonical_nav_entry(self) -> None:
        book = Book(title="章节书", author="作者", intro="简介")
        chapter = Chapter(title="第一章", lines=["正文"])
        book.root_chapters.append(chapter)
        book.spine.append(chapter)

        meta = Metadata(
            book_id="repair-nav-id",
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

            with zipfile.ZipFile(output_path, "r") as src:
                infos = src.infolist()
                nav_name = next((info.filename for info in infos if info.filename.endswith("nav.xhtml")), "")
                self.assertTrue(nav_name)
                tampered_path = Path(tmp) / "tampered.epub"
                with zipfile.ZipFile(tampered_path, "w") as dst:
                    for info in infos:
                        payload = src.read(info.filename)
                        target_name = "EPUB/../nav.xhtml" if info.filename == nav_name else info.filename
                        if target_name == "mimetype":
                            dst.writestr(target_name, payload, compress_type=zipfile.ZIP_STORED)
                            continue
                        zinfo = zipfile.ZipInfo(target_name, date_time=info.date_time)
                        zinfo.compress_type = info.compress_type
                        zinfo.comment = info.comment
                        zinfo.extra = info.extra
                        zinfo.internal_attr = info.internal_attr
                        zinfo.external_attr = info.external_attr
                        zinfo.create_system = info.create_system
                        zinfo.create_version = info.create_version
                        zinfo.extract_version = info.extract_version
                        zinfo.flag_bits = info.flag_bits
                        dst.writestr(zinfo, payload)

            tampered_path.replace(output_path)

            new_meta = Metadata(
                book_id="repair-nav-id",
                title="修复后标题",
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
            update_epub_metadata(output_path, new_meta)

            sections = list_epub_sections(output_path)
            self.assertTrue(sections)
            with zipfile.ZipFile(output_path, "r") as zf:
                names = set(zf.namelist())
                self.assertNotIn("EPUB/../nav.xhtml", names)
                self.assertTrue(any(name == "nav.xhtml" or name.endswith("/nav.xhtml") for name in names))

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

    def test_update_epub_metadata_preserves_inline_head_styles_when_css_empty(self) -> None:
        new_meta = Metadata(
            book_id="keep-head-style-id",
            title="新书名",
            author="新作者",
            language="zh-CN",
            description="新简介",
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            self._create_external_epub_with_inline_style(output_path, book_id="keep-head-style-id")
            update_epub_metadata(output_path, new_meta, css_text="")

            html_text = self._read_any_chapter_html(output_path)
            self.assertIn("<style>p{color:#d00;}</style>", html_text)
            extracted = extract_epub_metadata(output_path, "fallback")
            self.assertEqual(extracted["title"], "新书名")
            self.assertEqual(extracted["author"], "新作者")
            self.assertEqual(extracted["description"], "新简介")

    def test_update_epub_metadata_clears_existing_bindery_css_when_css_empty(self) -> None:
        new_meta = Metadata(
            book_id="clear-bindery-css-id",
            title="新书名",
            author="新作者",
            language="zh-CN",
            description="新简介",
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            self._create_external_epub_with_inline_style(output_path, book_id="clear-bindery-css-id")

            update_epub_metadata(output_path, new_meta, css_text="p{font-size:18px;}")
            update_epub_metadata(output_path, new_meta, css_text="")

            html_text = self._read_any_chapter_html(output_path)
            self.assertIn("<style>p{color:#d00;}</style>", html_text)
            self.assertNotIn("bindery.css", html_text)
            self.assertNotIn("bindery-overlay.css", html_text)
            with zipfile.ZipFile(output_path, "r") as zf:
                names = zf.namelist()
                self.assertFalse(any(name.endswith("/Styles/bindery.css") for name in names))
                self.assertFalse(any(name.endswith("/Styles/bindery-overlay.css") for name in names))

    def test_update_epub_metadata_with_cover_preserves_inline_head_styles(self) -> None:
        new_meta = Metadata(
            book_id="cover-only-id",
            title="新书名",
            author="新作者",
            language="zh-CN",
            description="新简介",
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            self._create_external_epub_with_inline_style(output_path, book_id="cover-only-id")
            cover_path = Path(tmp) / "cover.jpg"
            cover_path.write_bytes(b"\xff\xd8\xff\xd9")
            update_epub_metadata(output_path, new_meta, cover_path=cover_path, css_text="")

            html_text = self._read_any_chapter_html(output_path)
            self.assertIn("<style>p{color:#d00;}</style>", html_text)
            self.assertNotIn("bindery.css", html_text)
            with zipfile.ZipFile(output_path, "r") as zf:
                names = zf.namelist()
                self.assertTrue(any("cover" in Path(name).name.lower() for name in names))

    def test_update_epub_metadata_with_cover_and_css_appends_link_and_keeps_inline_style(self) -> None:
        new_meta = Metadata(
            book_id="cover-css-id",
            title="新书名",
            author="新作者",
            language="zh-CN",
            description="新简介",
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            self._create_external_epub_with_inline_style(output_path, book_id="cover-css-id")
            cover_path = Path(tmp) / "cover.jpg"
            cover_path.write_bytes(b"\xff\xd8\xff\xd9")
            update_epub_metadata(output_path, new_meta, cover_path=cover_path, css_text="p{font-size:18px;}")

            html_text = self._read_any_chapter_html(output_path)
            self.assertIn("<style>p{color:#d00;}</style>", html_text)
            self.assertIn("bindery.css", html_text)
            with zipfile.ZipFile(output_path, "r") as zf:
                names = zf.namelist()
                self.assertTrue(any(name.endswith("/Styles/bindery.css") for name in names))
                css_name = next(name for name in names if name.endswith("/Styles/bindery.css"))
                self.assertIn("font-size:18px", zf.read(css_name).decode("utf-8", errors="replace"))

    def test_update_epub_metadata_can_strip_original_css(self) -> None:
        new_meta = Metadata(
            book_id="strip-original-css-id",
            title="新书名",
            author="新作者",
            language="zh-CN",
            description="新简介",
            created_at="",
            updated_at="",
        )

        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            self._create_external_epub_with_linked_style(output_path, book_id="strip-original-css-id")
            update_epub_metadata(output_path, new_meta, css_text="", strip_original_css=True)

            html_text = self._read_any_chapter_html(output_path)
            self.assertNotIn("rel=\"stylesheet\"", html_text)
            self.assertNotIn("<style>", html_text)

            with zipfile.ZipFile(output_path, "r") as zf:
                names = zf.namelist()
                self.assertFalse(any(name.endswith("/Styles/book.css") for name in names))
                self.assertFalse(any(name.endswith("/Styles/bindery.css") for name in names))

    def test_strip_webp_assets_and_refs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "book.epub"
            self._create_external_epub_with_webp_refs(output_path, book_id="strip-webp-id")

            changed = strip_webp_assets_and_refs(output_path)
            self.assertTrue(changed)

            with zipfile.ZipFile(output_path, "r") as zf:
                names = zf.namelist()
                self.assertFalse(any(name.lower().endswith(".webp") for name in names))
                html_text = self._read_any_chapter_html(output_path)
                self.assertNotIn(".webp", html_text.lower())
                self.assertIn("fallback.jpg", html_text)

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
