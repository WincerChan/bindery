from __future__ import annotations

import datetime as dt
import html
from pathlib import Path
from typing import Iterable, Optional

from ebooklib import epub

from .models import Book, Metadata, Volume


def _render_section(title: str, lines: Iterable[str], lang: str, kind: str = "chapter") -> str:
    paragraphs = []
    for line in lines:
        if not line:
            continue
        paragraphs.append(f"    <p>{html.escape(line)}</p>")
    body = "\n".join(paragraphs) if paragraphs else ""
    return (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
        "<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"{lang}\">\n"
        "  <head>\n"
        "    <meta charset=\"utf-8\" />\n"
        "    <title>{title}</title>\n"
        "    <link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\" />\n"
        "  </head>\n"
        "  <body class=\"{kind}\">\n"
        "    <h2>{title}</h2>\n"
        "{body}\n"
        "  </body>\n"
        "</html>\n"
    ).format(lang=lang, title=html.escape(title), body=body, kind=kind)


def _render_intro(title: str, author: Optional[str], intro: str, lang: str) -> str:
    paragraphs = []
    if author:
        paragraphs.append(f"    <p class=\"author\">作者：{html.escape(author)}</p>")
    paragraphs.append("    <p class=\"intro-label\">简介</p>")
    for raw in intro.splitlines():
        line = raw.strip()
        if not line:
            continue
        paragraphs.append(f"    <p>{html.escape(line)}</p>")
    body = "\n".join(paragraphs)
    return (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
        "<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"{lang}\">\n"
        "  <head>\n"
        "    <meta charset=\"utf-8\" />\n"
        "    <title>{title}</title>\n"
        "    <link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\" />\n"
        "  </head>\n"
        "  <body class=\"front-matter\">\n"
        "    <h1>{title}</h1>\n"
        "{body}\n"
        "  </body>\n"
        "</html>\n"
    ).format(lang=lang, title=html.escape(title), body=body)


def _add_metadata(book: epub.EpubBook, meta: Metadata) -> None:
    book_id = meta.book_id
    if not book_id.startswith("urn:"):
        book_id = f"urn:uuid:{book_id}"
    book.set_identifier(book_id)
    book.set_title(meta.title)
    book.set_language(meta.language or "zh-CN")

    if meta.author:
        book.add_author(meta.author)
    if meta.description:
        book.add_metadata("DC", "description", meta.description)
    if meta.publisher:
        book.add_metadata("DC", "publisher", meta.publisher)
    if meta.published:
        book.add_metadata("DC", "date", meta.published)
    if meta.isbn:
        book.add_metadata("DC", "identifier", meta.isbn, {"id": "isbn"})
    for tag in meta.tags:
        if tag:
            book.add_metadata("DC", "subject", tag)
    if meta.rating is not None:
        book.add_metadata(None, "meta", str(meta.rating), {"name": "rating"})

    modified = (
        dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    book.add_metadata(None, "meta", modified, {"property": "dcterms:modified"})


def build_epub(book_data: Book, meta: Metadata, output_path: Path) -> None:
    epub_book = epub.EpubBook()
    _add_metadata(epub_book, meta)

    css = (
        "body { font-family: \"Noto Serif SC\", serif; line-height: 1.7; }\n"
        "p { text-indent: 2em; margin: 0 0 0.8em; }\n"
        "h2 { font-weight: 700; font-size: 1.2em; margin: 1.5em 0 1em; }\n"
        "h1 { font-weight: 800; font-size: 1.6em; margin: 1.5em 0 1em; }\n"
        ".front-matter p.author { text-align: center; text-indent: 0; margin: 0 0 1.5em; }\n"
        ".front-matter p.intro-label { text-indent: 0; font-weight: 700; margin: 1.2em 0 0.6em; }\n"
        ".volume p, .volume h2 { text-indent: 0; }\n"
    )
    style_item = epub.EpubItem(uid="style", file_name="style.css", media_type="text/css", content=css)
    epub_book.add_item(style_item)

    docs: list[epub.EpubHtml] = []
    toc: list[object] = []
    spine: list[object] = ["nav"]
    lang = meta.language or "zh-CN"

    section_index = 1

    def make_doc(title: str, lines: Iterable[str], kind: str = "chapter") -> epub.EpubHtml:
        nonlocal section_index
        file_name = f"section_{section_index:04d}.xhtml"
        section_index += 1
        doc = epub.EpubHtml(title=title, file_name=file_name, lang=lang)
        doc.content = _render_section(title, lines, lang, kind=kind)
        doc.add_item(style_item)
        docs.append(doc)
        return doc

    if book_data.intro:
        intro_doc = epub.EpubHtml(title="简介", file_name="section_0000.xhtml", lang=lang)
        intro_doc.content = _render_intro(meta.title, meta.author or book_data.author, book_data.intro, lang)
        intro_doc.add_item(style_item)
        docs.append(intro_doc)
        toc.append(intro_doc)
        spine.append(intro_doc)

    current_volume_items: Optional[list[epub.EpubHtml]] = None
    for item in book_data.spine:
        if isinstance(item, Volume):
            current_volume_items = []
            toc.append((epub.Section(item.title), current_volume_items))
            if item.lines:
                doc = make_doc(item.title, item.lines, kind="volume")
                current_volume_items.append(doc)
                spine.append(doc)
            continue

        doc = make_doc(item.title, item.lines, kind="chapter")
        if item.volume is not None and current_volume_items is not None:
            current_volume_items.append(doc)
        else:
            current_volume_items = None
            toc.append(doc)
        spine.append(doc)

    if not docs:
        doc = make_doc("正文", ["（无内容）"], kind="chapter")
        toc.append(doc)
        spine.append(doc)

    epub_book.toc = toc
    epub_book.spine = spine

    epub_book.add_item(epub.EpubNcx())
    epub_book.add_item(epub.EpubNav())

    for doc in docs:
        epub_book.add_item(doc)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    epub.write_epub(str(output_path), epub_book, {})
