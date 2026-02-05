from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
import html
import re
from pathlib import Path
from typing import Iterable, Optional

from ebooklib import epub
import ebooklib

from .models import Book, Metadata, Volume


@dataclass
class EpubSection:
    title: str
    item_path: str


DEFAULT_EPUB_CSS = (
    "body { font-family: \"Noto Serif SC\", serif; line-height: 1.7; }\n"
    "p { text-indent: 2em; margin: 0 0 0.8em; }\n"
    "h2 { font-weight: 700; font-size: 1.2em; margin: 1.5em 0 1em; }\n"
    "h1 { font-weight: 800; font-size: 1.6em; margin: 1.5em 0 1em; }\n"
    ".front-matter p.author { text-align: center; text-indent: 0; margin: 0 0 1.5em; }\n"
    ".front-matter p.intro-label { text-indent: 0; font-weight: 700; margin: 1.2em 0 0.6em; }\n"
    ".volume p, .volume h2 { text-indent: 0; }\n"
)

BINDERY_CSS_NAME = "bindery.css"


def _render_section(title: str, lines: Iterable[str], lang: str, kind: str = "chapter") -> str:
    paragraphs = []
    for line in lines:
        if not line:
            continue
        paragraphs.append(f"    <p>{html.escape(line)}</p>")
    body = "\n".join(paragraphs) if paragraphs else ""
    return (
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
    identifier = meta.identifier or meta.book_id
    if not identifier.startswith("urn:"):
        identifier = f"urn:uuid:{identifier}"
    book.set_identifier(identifier)
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
    if meta.identifier:
        book.add_metadata("DC", "identifier", meta.identifier, {"id": "identifier"})
    if meta.series:
        book.add_metadata(None, "meta", meta.series, {"property": "belongs-to-collection"})
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


def _clear_metadata(book: epub.EpubBook, *, keep_cover: bool = False) -> None:
    dc_ns = epub.NAMESPACES["DC"]
    opf_ns = epub.NAMESPACES["OPF"]
    dc = book.metadata.get(dc_ns, {})
    for key in ("identifier", "title", "language", "creator", "description", "publisher", "date", "subject"):
        if key in dc:
            dc.pop(key, None)
    if dc:
        book.metadata[dc_ns] = dc
    opf = book.metadata.get(opf_ns, {})
    meta_items = opf.get("meta", [])
    filtered = []
    for value, attrs in meta_items:
        if attrs.get("property") in {"dcterms:modified", "belongs-to-collection"}:
            continue
        if attrs.get("name") == "rating":
            continue
        if not keep_cover and attrs.get("name") == "cover":
            continue
        filtered.append((value, attrs))
    if opf:
        opf["meta"] = filtered
        book.metadata[opf_ns] = opf


def update_epub_metadata(
    epub_file: Path,
    meta: Metadata,
    cover_path: Optional[Path] = None,
    *,
    css_text: Optional[str] = None,
) -> None:
    book = epub.read_epub(str(epub_file))
    _normalize_spine_and_toc(book)
    cover_ok = bool(cover_path and cover_path.exists())
    _clear_metadata(book, keep_cover=not cover_ok)
    _add_metadata(book, meta)
    if cover_ok:
        book.set_cover(cover_path.name, cover_path.read_bytes())
    if css_text is not None:
        _apply_bindery_css_overlay(book, css_text)
    epub.write_epub(str(epub_file), book, {"epub3_pages": False})


def build_epub(
    book_data: Book,
    meta: Metadata,
    output_path: Path,
    cover_path: Optional[Path] = None,
    css_text: Optional[str] = None,
) -> None:
    epub_book = epub.EpubBook()
    _add_metadata(epub_book, meta)

    css = css_text.strip() if css_text and css_text.strip() else DEFAULT_EPUB_CSS
    style_item = epub.EpubItem(uid="style", file_name="style.css", media_type="text/css", content=css)
    epub_book.add_item(style_item)

    if cover_path and cover_path.exists():
        cover_bytes = cover_path.read_bytes()
        epub_book.set_cover(cover_path.name, cover_bytes)

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
    # Disable page-list generation to avoid failures when a section body is empty.
    epub.write_epub(str(output_path), epub_book, {"epub3_pages": False})


def extract_cover(epub_file: Path) -> Optional[tuple[bytes, str]]:
    if not epub_file.exists():
        return None
    book = epub.read_epub(str(epub_file))
    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_COVER:
            name = item.get_name() or "cover"
            return item.get_content(), name
    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_IMAGE:
            name = item.get_name() or ""
            if "cover" in name.lower():
                return item.get_content(), name
    return None


def _looks_like_isbn(value: str) -> bool:
    cleaned = re.sub(r"[^0-9Xx]", "", value or "")
    return len(cleaned) in {10, 13}


def _first_metadata(book: epub.EpubBook, namespace: str, name: str) -> Optional[str]:
    items = book.get_metadata(namespace, name)
    for value, _ in items:
        if value:
            return value.strip()
    return None


def extract_epub_metadata(epub_file: Path, fallback_title: str) -> dict:
    book = epub.read_epub(str(epub_file))
    title = _first_metadata(book, "DC", "title") or fallback_title
    author = _first_metadata(book, "DC", "creator")
    language = _first_metadata(book, "DC", "language") or "zh-CN"
    description = _first_metadata(book, "DC", "description")
    publisher = _first_metadata(book, "DC", "publisher")
    published = _first_metadata(book, "DC", "date")

    tags = [value.strip() for value, _ in book.get_metadata("DC", "subject") if value and value.strip()]

    identifier = None
    isbn = None
    for value, attrs in book.get_metadata("DC", "identifier"):
        if not value:
            continue
        cleaned = value.strip()
        if attrs.get("id") == "isbn" or _looks_like_isbn(cleaned):
            if not isbn:
                isbn = cleaned
            continue
        if attrs.get("id") == "identifier" or identifier is None:
            identifier = cleaned

    series = None
    rating = None
    for value, attrs in book.get_metadata("OPF", "meta"):
        if attrs.get("property") == "belongs-to-collection" and value:
            series = value.strip()
        if attrs.get("name") == "rating" and value:
            try:
                rating_value = int(float(value))
            except (TypeError, ValueError):
                continue
            rating = max(0, min(5, rating_value))

    return {
        "title": title,
        "author": author,
        "language": language,
        "description": description,
        "series": series,
        "identifier": identifier,
        "publisher": publisher,
        "tags": tags,
        "published": published,
        "isbn": isbn,
        "rating": rating,
    }


def _strip_scripts(html_text: str) -> str:
    return re.sub(r"<script\\b[^>]*>.*?</script>", "", html_text, flags=re.IGNORECASE | re.DOTALL)


def _inject_base(html_text: str, base_href: str) -> str:
    base_tag = f'<base href="{html.escape(base_href, quote=True)}" />'
    match = re.search(r"<head[^>]*>", html_text, flags=re.IGNORECASE)
    if match:
        idx = match.end()
        return f"{html_text[:idx]}{base_tag}{html_text[idx:]}"
    return f"<head>{base_tag}</head>{html_text}"


def _extract_title_from_html(html_text: str) -> Optional[str]:
    for pattern in (r"<title[^>]*>(.*?)</title>", r"<h1[^>]*>(.*?)</h1>", r"<h2[^>]*>(.*?)</h2>"):
        match = re.search(pattern, html_text, flags=re.IGNORECASE | re.DOTALL)
        if match:
            text = re.sub(r"<[^>]+>", "", match.group(1))
            text = html.unescape(text).strip()
            if text:
                return text
    return None


def _spine_items(book: epub.EpubBook) -> list[ebooklib.epub.EpubItem]:
    items: list[ebooklib.epub.EpubItem] = []
    for entry in book.spine:
        if isinstance(entry, tuple):
            entry = entry[0]
        item = None
        if isinstance(entry, str):
            item = book.get_item_with_id(entry) or book.get_item_with_href(entry)
        else:
            item = entry
        if not item:
            continue
        if item.get_type() == ebooklib.ITEM_NAVIGATION:
            continue
        if item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        items.append(item)
    if items:
        return items
    return [item for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT) if item.get_type() != ebooklib.ITEM_NAVIGATION]


def _normalize_spine_and_toc(book: epub.EpubBook) -> None:
    docs = _spine_items(book)
    for idx, item in enumerate(docs):
        if getattr(item, "uid", None) is None:
            uid = getattr(item, "id", None) or f"doc_{idx}"
            setattr(item, "uid", uid)

    def assign_uid(entries: list, start: int = 0) -> int:
        counter = start
        for entry in entries:
            if isinstance(entry, tuple) and len(entry) == 2 and isinstance(entry[1], list):
                item, children = entry
                if getattr(item, "uid", None) is None:
                    uid = getattr(item, "id", None) or f"toc_{counter}"
                    setattr(item, "uid", uid)
                    counter += 1
                counter = assign_uid(children, counter)
                continue
            if getattr(entry, "uid", None) is None:
                uid = getattr(entry, "id", None) or f"toc_{counter}"
                setattr(entry, "uid", uid)
                counter += 1
        return counter

    if book.toc:
        assign_uid(book.toc)
    elif docs:
        book.toc = docs


def list_epub_sections(epub_file: Path) -> list[EpubSection]:
    book = epub.read_epub(str(epub_file))
    sections: list[EpubSection] = []
    for item in _spine_items(book):
        title = getattr(item, "title", None)
        if not title and hasattr(item, "get_title"):
            try:
                title = item.get_title()
            except Exception:
                title = None
        content_text = None
        if not title:
            try:
                content_text = item.get_content().decode("utf-8", errors="replace")
            except Exception:
                content_text = None
            if content_text:
                title = _extract_title_from_html(content_text)
        if not title:
            name = item.get_name() or "section"
            title = Path(name).stem
        sections.append(EpubSection(title=title, item_path=item.get_name()))
    return sections


def load_epub_item(epub_file: Path, item_path: str, base_href: str) -> tuple[bytes, str]:
    book = epub.read_epub(str(epub_file))
    target_path = item_path.lstrip("/")
    target = None
    for item in book.get_items():
        name = (item.get_name() or "").lstrip("/")
        if name == target_path:
            target = item
            break
    if not target:
        raise FileNotFoundError(item_path)
    content = target.get_content()
    media_type = target.media_type or "application/octet-stream"
    if target.get_type() == ebooklib.ITEM_DOCUMENT:
        text = content.decode("utf-8", errors="replace")
        text = _strip_scripts(text)
        text = _inject_base(text, base_href)
        content = text.encode("utf-8")
        media_type = "text/html; charset=utf-8"
    return content, media_type


def epub_base_href(base_prefix: str, item_path: str) -> str:
    """Compute a <base href> for an EPUB item so relative assets resolve correctly.

    Many EPUBs store chapters under a directory like "OEBPS/Text/" and assets under
    "OEBPS/Images/". Chapter HTML typically references assets via "../Images/...".
    If we always use "/.../epub/" as the base, "../Images/..." escapes the epub path.
    """

    prefix = base_prefix if base_prefix.endswith("/") else f"{base_prefix}/"
    safe = Path(item_path.lstrip("/"))
    parent = safe.parent.as_posix()
    if not parent or parent == ".":
        return prefix
    return f"{prefix}{parent.strip('/')}/"


def _inject_stylesheet_link(html_text: str, href: str) -> str:
    if re.search(rf"<link\\b[^>]*href=[\"']{re.escape(href)}[\"'][^>]*>", html_text, flags=re.IGNORECASE):
        return html_text
    link_tag = f'<link rel="stylesheet" type="text/css" href="{html.escape(href, quote=True)}" />'
    match = re.search(r"</head\\s*>", html_text, flags=re.IGNORECASE)
    if match:
        idx = match.start()
        return f"{html_text[:idx]}{link_tag}{html_text[idx:]}"
    match = re.search(r"<head[^>]*>", html_text, flags=re.IGNORECASE)
    if match:
        idx = match.end()
        return f"{html_text[:idx]}{link_tag}{html_text[idx:]}"
    return f"<head>{link_tag}</head>{html_text}"


def _remove_stylesheet_link(html_text: str, href: str) -> str:
    return re.sub(
        rf"<link\\b[^>]*href=[\"']{re.escape(href)}[\"'][^>]*>\\s*",
        "",
        html_text,
        flags=re.IGNORECASE,
    )


def _apply_bindery_css_overlay(book: epub.EpubBook, css_text: str) -> None:
    css_clean = css_text.strip()
    docs = _spine_items(book)
    by_dir: dict[str, list[ebooklib.epub.EpubItem]] = {}
    for item in docs:
        name = (item.get_name() or "").lstrip("/")
        parent = str(Path(name).parent) if name else "."
        by_dir.setdefault(parent, []).append(item)

    if css_clean:
        for directory in by_dir:
            if directory in {"", "."}:
                file_name = BINDERY_CSS_NAME
            else:
                file_name = str(Path(directory) / BINDERY_CSS_NAME)
            existing = book.get_item_with_href(file_name)
            if existing and existing.get_type() == ebooklib.ITEM_STYLE:
                existing.set_content(css_clean.encode("utf-8"))
            else:
                style_item = epub.EpubItem(
                    uid=f"bindery-css:{file_name}",
                    file_name=file_name,
                    media_type="text/css",
                    content=css_clean.encode("utf-8"),
                )
                book.add_item(style_item)
    for items in by_dir.values():
        for item in items:
            # ebooklib 在写 EPUB / 生成 HTML 时会重建 <head>，只保留 item.links。
            # 因此不能通过“字符串注入 <link>”的方式写入样式表链接。
            if not isinstance(item, epub.EpubHtml):
                continue
            if css_clean:
                if not any(link.get("href") == BINDERY_CSS_NAME for link in item.links):
                    item.add_link(href=BINDERY_CSS_NAME, rel="stylesheet", type="text/css")
            else:
                item.links = [link for link in item.links if link.get("href") != BINDERY_CSS_NAME]
