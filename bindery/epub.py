from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
import html
import posixpath
import re
from pathlib import Path, PurePosixPath
import tempfile
from typing import Iterable, Optional
import zipfile
import xml.etree.ElementTree as ET

from ebooklib import epub
import ebooklib

from .models import Book, Metadata, Volume


@dataclass
class EpubSection:
    title: str
    item_path: str


BINDERY_CSS_NAME = "bindery.css"
CHAPTER_STAMP_RE = re.compile(
    r"^\s*(第[0-9零〇一二两三四五六七八九十百千万亿\d]+章)\s*[:：、.\-·]?\s*(.+)\s*$"
)
CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"
OPF_NS = epub.NAMESPACES["OPF"]
DC_NS = epub.NAMESPACES["DC"]
BINDERY_CSS_BASENAMES = {"bindery.css", "bindery-overlay.css"}


def _canonical_zip_member(name: str) -> str:
    normalized = posixpath.normpath((name or "").replace("\\", "/")).lstrip("/")
    while normalized.startswith("../"):
        normalized = normalized[3:]
    return "" if normalized in {"", "."} else normalized


def _missing_member_from_keyerror(exc: KeyError) -> str:
    match = re.search(r"named '([^']+)'", str(exc))
    if not match:
        return ""
    return _canonical_zip_member(match.group(1))


def _normalize_epub_archive_paths(epub_file: Path, expected_missing: str = "") -> bool:
    if not epub_file.exists():
        return False
    expected = _canonical_zip_member(expected_missing)
    expected_name = PurePosixPath(expected).name if expected else ""
    with zipfile.ZipFile(epub_file, "r") as src:
        infos = src.infolist()
        needs_rewrite = False
        for info in infos:
            original = (info.filename or "").replace("\\", "/")
            canonical = _canonical_zip_member(original)
            if expected and ".." in PurePosixPath(original).parts:
                if PurePosixPath(canonical).name == expected_name:
                    canonical = expected
            if canonical != info.filename:
                needs_rewrite = True
        if not needs_rewrite:
            return False

        entries: list[tuple[str, zipfile.ZipInfo, bytes]] = []
        for info in infos:
            original = (info.filename or "").replace("\\", "/")
            canonical = _canonical_zip_member(original)
            if expected and ".." in PurePosixPath(original).parts:
                if PurePosixPath(canonical).name == expected_name:
                    canonical = expected
            if not canonical:
                continue
            entries.append((canonical, info, src.read(info.filename)))

    tmp_handle = tempfile.NamedTemporaryFile(
        prefix=f"{epub_file.stem}.",
        suffix=".epub",
        dir=str(epub_file.parent),
        delete=False,
    )
    tmp_path = Path(tmp_handle.name)
    tmp_handle.close()

    written: set[str] = set()
    try:
        with zipfile.ZipFile(tmp_path, "w") as dst:
            # EPUB 规范要求 mimetype 为第一个且不压缩。
            for canonical, info, payload in entries:
                if canonical != "mimetype" or canonical in written:
                    continue
                dst.writestr(canonical, payload, compress_type=zipfile.ZIP_STORED)
                written.add(canonical)

            for canonical, info, payload in entries:
                if canonical in written:
                    continue
                zinfo = zipfile.ZipInfo(canonical, date_time=info.date_time)
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
                written.add(canonical)

        tmp_path.replace(epub_file)
        return True
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def _read_epub_resilient(epub_file: Path) -> epub.EpubBook:
    try:
        return epub.read_epub(str(epub_file))
    except KeyError as exc:
        missing = _missing_member_from_keyerror(exc)
        if not missing:
            raise
        if not _normalize_epub_archive_paths(epub_file, expected_missing=missing):
            raise
        return epub.read_epub(str(epub_file))


def _tag_local_name(tag: str) -> str:
    if not tag:
        return ""
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _find_first_child_by_local_name(node: ET.Element, local_name: str) -> Optional[ET.Element]:
    for child in list(node):
        if _tag_local_name(child.tag) == local_name:
            return child
    return None


def _resolve_opf_href(opf_path: str, href: str) -> str:
    opf_dir = PurePosixPath(opf_path).parent
    joined = posixpath.normpath(posixpath.join(opf_dir.as_posix(), href))
    return _canonical_zip_member(joined)


def _relative_href(from_member: str, to_member: str) -> str:
    from_dir = PurePosixPath(from_member).parent.as_posix()
    start = from_dir if from_dir not in {"", "."} else "."
    return posixpath.relpath(to_member, start=start)


def _derive_package_root_from_docs(doc_members: list[str]) -> PurePosixPath:
    if not doc_members:
        return PurePosixPath(".")
    doc_dirs = [PurePosixPath(member).parent.as_posix() for member in doc_members]
    common = posixpath.commonpath(doc_dirs) or "."
    root = PurePosixPath(common)
    if root.as_posix() in {"", "."}:
        return PurePosixPath(".")
    if root.parts and root.parts[-1].lower() in {"text", "xhtml", "html"}:
        parent = root.parent.as_posix()
        return PurePosixPath(".") if parent in {"", "."} else root.parent
    return root


def _strip_bindery_css_links(html_text: str) -> str:
    return re.sub(
        r"<link\b[^>]*href=['\"][^'\"]*bindery(?:-overlay)?\.css[^'\"]*['\"][^>]*>\s*",
        "",
        html_text,
        flags=re.IGNORECASE,
    )


def _append_stylesheet_link(html_text: str, href: str) -> str:
    safe_href = html.escape(href, quote=True)
    link_tag = f'<link rel="stylesheet" type="text/css" href="{safe_href}" />'
    self_close = re.search(r"<head([^>]*)\s*/>", html_text, flags=re.IGNORECASE)
    if self_close:
        attrs = self_close.group(1) or ""
        replacement = f"<head{attrs}>{link_tag}</head>"
        return re.sub(r"<head([^>]*)\s*/>", replacement, html_text, count=1, flags=re.IGNORECASE)
    closing = re.search(r"</head>", html_text, flags=re.IGNORECASE)
    if closing:
        idx = closing.start()
        return f"{html_text[:idx]}{link_tag}{html_text[idx:]}"
    opening = re.search(r"<head[^>]*>", html_text, flags=re.IGNORECASE)
    if opening:
        idx = opening.end()
        return f"{html_text[:idx]}{link_tag}{html_text[idx:]}"
    return f"<head>{link_tag}</head>{html_text}"


def _patch_doc_html_bindery_css(html_text: str, href: Optional[str]) -> str:
    stripped = _strip_bindery_css_links(html_text)
    if not href:
        return stripped
    return _append_stylesheet_link(stripped, href)


def _guess_image_media_type(name: str) -> str:
    suffix = Path(name).suffix.lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
    }.get(suffix, "image/jpeg")


def _opf_path_from_container(zf: zipfile.ZipFile) -> str:
    try:
        container_raw = zf.read("META-INF/container.xml")
    except KeyError as exc:
        raise KeyError("Missing META-INF/container.xml") from exc
    root = ET.fromstring(container_raw)
    rootfile = root.find(f".//{{{CONTAINER_NS}}}rootfile")
    full_path = ""
    if rootfile is not None:
        full_path = (rootfile.attrib.get("full-path") or "").strip()
    if not full_path:
        for node in root.iter():
            if _tag_local_name(node.tag) != "rootfile":
                continue
            candidate = (node.attrib.get("full-path") or "").strip()
            if candidate:
                full_path = candidate
                break
    normalized = _canonical_zip_member(full_path)
    if not normalized:
        raise KeyError("Missing OPF path in container.xml")
    return normalized


def _apply_metadata_to_opf_root(
    root: ET.Element,
    meta: Metadata,
    *,
    keep_cover: bool,
    cover_meta_id: Optional[str] = None,
) -> None:
    metadata_node = root.find(f"{{{OPF_NS}}}metadata")
    if metadata_node is None:
        metadata_node = _find_first_child_by_local_name(root, "metadata")
    if metadata_node is None:
        metadata_node = ET.Element(f"{{{OPF_NS}}}metadata")
        root.insert(0, metadata_node)

    dc_locals_to_clear = {"identifier", "title", "language", "creator", "description", "publisher", "date", "subject"}
    for child in list(metadata_node):
        local = _tag_local_name(child.tag)
        if local in dc_locals_to_clear:
            metadata_node.remove(child)
            continue
        if local != "meta":
            continue
        prop = str(child.attrib.get("property") or "").strip()
        name = str(child.attrib.get("name") or "").strip()
        if prop in {"dcterms:modified", "belongs-to-collection"}:
            metadata_node.remove(child)
            continue
        if name == "rating":
            metadata_node.remove(child)
            continue
        if (not keep_cover or cover_meta_id) and name == "cover":
            metadata_node.remove(child)

    identifier = meta.identifier or meta.book_id
    if not identifier.startswith("urn:"):
        identifier = f"urn:uuid:{identifier}"
    identifier_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}identifier")
    identifier_el.text = identifier

    title_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}title")
    title_el.text = meta.title

    language_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}language")
    language_el.text = meta.language or "zh-CN"

    if meta.author:
        author_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}creator")
        author_el.text = meta.author
    if meta.description:
        description_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}description")
        description_el.text = meta.description
    if meta.publisher:
        publisher_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}publisher")
        publisher_el.text = meta.publisher
    if meta.published:
        published_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}date")
        published_el.text = meta.published
    if meta.identifier:
        user_identifier_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}identifier")
        user_identifier_el.set("id", "identifier")
        user_identifier_el.text = meta.identifier
    if meta.series:
        series_el = ET.SubElement(metadata_node, f"{{{OPF_NS}}}meta")
        series_el.set("property", "belongs-to-collection")
        series_el.text = meta.series
    if meta.isbn:
        isbn_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}identifier")
        isbn_el.set("id", "isbn")
        isbn_el.text = meta.isbn
    for tag in meta.tags:
        if not tag:
            continue
        subject_el = ET.SubElement(metadata_node, f"{{{DC_NS}}}subject")
        subject_el.text = tag
    if meta.rating is not None:
        rating_el = ET.SubElement(metadata_node, f"{{{OPF_NS}}}meta")
        rating_el.set("name", "rating")
        rating_el.text = str(meta.rating)

    modified = (
        dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    modified_el = ET.SubElement(metadata_node, f"{{{OPF_NS}}}meta")
    modified_el.set("property", "dcterms:modified")
    modified_el.text = modified
    if cover_meta_id:
        cover_el = ET.SubElement(metadata_node, f"{{{OPF_NS}}}meta")
        cover_el.set("name", "cover")
        cover_el.set("content", cover_meta_id)


def _rewrite_opf_metadata(
    opf_bytes: bytes,
    meta: Metadata,
    *,
    keep_cover: bool,
    cover_meta_id: Optional[str] = None,
) -> bytes:
    root = ET.fromstring(opf_bytes)
    _apply_metadata_to_opf_root(root, meta, keep_cover=keep_cover, cover_meta_id=cover_meta_id)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _update_epub_metadata_opf_only(epub_file: Path, meta: Metadata, *, keep_cover: bool) -> bool:
    if not epub_file.exists():
        return False
    with zipfile.ZipFile(epub_file, "r") as src:
        infos = src.infolist()
        try:
            opf_path = _opf_path_from_container(src)
        except Exception:
            return False

        opf_info: Optional[zipfile.ZipInfo] = None
        entries: list[tuple[zipfile.ZipInfo, bytes]] = []
        for info in infos:
            payload = src.read(info)
            if _canonical_zip_member(info.filename) == opf_path:
                opf_info = info
            entries.append((info, payload))
        if opf_info is None:
            return False

        try:
            rewritten_opf = _rewrite_opf_metadata(src.read(opf_info), meta, keep_cover=keep_cover)
        except Exception:
            return False

    tmp_handle = tempfile.NamedTemporaryFile(
        prefix=f"{epub_file.stem}.",
        suffix=".epub",
        dir=str(epub_file.parent),
        delete=False,
    )
    tmp_path = Path(tmp_handle.name)
    tmp_handle.close()

    try:
        with zipfile.ZipFile(tmp_path, "w") as dst:
            for info, payload in entries:
                content = rewritten_opf if _canonical_zip_member(info.filename) == opf_path else payload
                if info.filename == "mimetype":
                    dst.writestr("mimetype", content, compress_type=zipfile.ZIP_STORED)
                    continue
                zinfo = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                zinfo.compress_type = info.compress_type
                zinfo.comment = info.comment
                zinfo.extra = info.extra
                zinfo.internal_attr = info.internal_attr
                zinfo.external_attr = info.external_attr
                zinfo.create_system = info.create_system
                zinfo.create_version = info.create_version
                zinfo.extract_version = info.extract_version
                zinfo.flag_bits = info.flag_bits
                dst.writestr(zinfo, content)
        tmp_path.replace(epub_file)
        return True
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def _update_epub_preserve_documents(
    epub_file: Path,
    meta: Metadata,
    *,
    cover_path: Optional[Path],
    css_text: Optional[str],
) -> bool:
    cover_ok = bool(cover_path and cover_path.exists())
    css_requested = css_text is not None
    css_clean = css_text.strip() if isinstance(css_text, str) else ""
    if not cover_ok and not css_requested:
        return False

    with zipfile.ZipFile(epub_file, "r") as src:
        infos = src.infolist()
        try:
            opf_path = _opf_path_from_container(src)
        except Exception:
            return False
        opf_info = next((info for info in infos if _canonical_zip_member(info.filename) == opf_path), None)
        if opf_info is None:
            return False

        root = ET.fromstring(src.read(opf_info.filename))
        manifest = root.find(f"{{{OPF_NS}}}manifest")
        if manifest is None:
            manifest = _find_first_child_by_local_name(root, "manifest")
        if manifest is None:
            return False
        spine = root.find(f"{{{OPF_NS}}}spine")
        if spine is None:
            spine = _find_first_child_by_local_name(root, "spine")

        manifest_items = [item for item in list(manifest) if _tag_local_name(item.tag) == "item"]
        items_by_id: dict[str, ET.Element] = {}
        for item in manifest_items:
            item_id = str(item.attrib.get("id") or "").strip()
            if item_id:
                items_by_id[item_id] = item

        doc_items: list[ET.Element] = []
        if spine is not None:
            for itemref in list(spine):
                if _tag_local_name(itemref.tag) != "itemref":
                    continue
                idref = str(itemref.attrib.get("idref") or "").strip()
                if not idref or idref not in items_by_id:
                    continue
                item = items_by_id[idref]
                media_type = str(item.attrib.get("media-type") or "").strip().lower()
                properties = str(item.attrib.get("properties") or "")
                if media_type not in {"application/xhtml+xml", "text/html"}:
                    continue
                if "nav" in properties.split():
                    continue
                doc_items.append(item)
        if not doc_items:
            for item in manifest_items:
                media_type = str(item.attrib.get("media-type") or "").strip().lower()
                properties = str(item.attrib.get("properties") or "")
                if media_type not in {"application/xhtml+xml", "text/html"}:
                    continue
                if "nav" in properties.split():
                    continue
                doc_items.append(item)

        doc_members: list[str] = []
        for item in doc_items:
            href = str(item.attrib.get("href") or "").strip()
            if not href:
                continue
            member = _resolve_opf_href(opf_path, href)
            if member:
                doc_members.append(member)

        opf_dir = PurePosixPath(opf_path).parent.as_posix()
        opf_dir_start = opf_dir if opf_dir not in {"", "."} else "."

        replacements: dict[str, bytes] = {}
        remove_members: set[str] = set()

        css_member: Optional[str] = None
        if css_requested:
            bindery_items = [
                item
                for item in manifest_items
                if Path(str(item.attrib.get("href") or "")).name.lower() in BINDERY_CSS_BASENAMES
                or str(item.attrib.get("id") or "").startswith("bindery-css")
            ]
            for item in bindery_items:
                href = str(item.attrib.get("href") or "").strip()
                if href:
                    member = _resolve_opf_href(opf_path, href)
                    if member:
                        remove_members.add(member)
                manifest.remove(item)

            if css_clean:
                package_root = _derive_package_root_from_docs(doc_members)
                css_member = _canonical_zip_member((package_root / "Styles" / BINDERY_CSS_NAME).as_posix())
                css_href = posixpath.relpath(css_member, start=opf_dir_start)
                css_item_id = "bindery-css"
                suffix = 1
                while css_item_id in items_by_id:
                    css_item_id = f"bindery-css-{suffix}"
                    suffix += 1
                css_item = ET.SubElement(manifest, f"{{{OPF_NS}}}item")
                css_item.set("id", css_item_id)
                css_item.set("href", css_href)
                css_item.set("media-type", "text/css")
                replacements[css_member] = css_clean.encode("utf-8")

        cover_meta_id: Optional[str] = None
        if cover_ok and cover_path is not None:
            cover_bytes = cover_path.read_bytes()
            original_name = cover_path.name or "cover.jpg"
            cover_media_type = _guess_image_media_type(original_name)

            cover_item: Optional[ET.Element] = None
            for item in manifest_items:
                media_type = str(item.attrib.get("media-type") or "").strip().lower()
                properties = str(item.attrib.get("properties") or "")
                if "cover-image" in properties.split():
                    cover_item = item
                    break
                if media_type.startswith("image/"):
                    item_id = str(item.attrib.get("id") or "").strip().lower()
                    item_href = str(item.attrib.get("href") or "").strip().lower()
                    if "cover" in item_id or "cover" in item_href:
                        cover_item = item
                        break

            if cover_item is not None:
                cover_item_id = str(cover_item.attrib.get("id") or "").strip() or "cover-image"
                cover_href = str(cover_item.attrib.get("href") or "").strip()
                ext = Path(original_name).suffix or Path(cover_href).suffix or ".jpg"
                if not cover_href:
                    cover_href = f"Images/cover{ext.lower()}"
                cover_member = _resolve_opf_href(opf_path, cover_href)
                cover_item.set("id", cover_item_id)
                cover_item.set("href", posixpath.relpath(cover_member, start=opf_dir_start))
                cover_item.set("media-type", cover_media_type)
                cover_item.set("properties", "cover-image")
                cover_meta_id = cover_item_id
            else:
                ext = Path(original_name).suffix.lower() or ".jpg"
                package_root = _derive_package_root_from_docs(doc_members)
                cover_member = _canonical_zip_member((package_root / "Images" / f"cover{ext}").as_posix())
                cover_href = posixpath.relpath(cover_member, start=opf_dir_start)
                cover_item_id = "cover-image"
                suffix = 1
                while cover_item_id in items_by_id:
                    cover_item_id = f"cover-image-{suffix}"
                    suffix += 1
                cover_item = ET.SubElement(manifest, f"{{{OPF_NS}}}item")
                cover_item.set("id", cover_item_id)
                cover_item.set("href", cover_href)
                cover_item.set("media-type", cover_media_type)
                cover_item.set("properties", "cover-image")
                cover_meta_id = cover_item_id

            replacements[cover_member] = cover_bytes

        if css_requested:
            for member in doc_members:
                info = next((it for it in infos if _canonical_zip_member(it.filename) == member), None)
                if info is None:
                    continue
                original_text = src.read(info.filename).decode("utf-8", errors="replace")
                href = _relative_href(member, css_member) if css_member else None
                patched = _patch_doc_html_bindery_css(original_text, href)
                replacements[member] = patched.encode("utf-8")

        _apply_metadata_to_opf_root(
            root,
            meta,
            keep_cover=not cover_ok,
            cover_meta_id=cover_meta_id,
        )
        replacements[opf_path] = ET.tostring(root, encoding="utf-8", xml_declaration=True)

        entries: list[tuple[zipfile.ZipInfo, bytes]] = [(info, src.read(info.filename)) for info in infos]

    tmp_handle = tempfile.NamedTemporaryFile(
        prefix=f"{epub_file.stem}.",
        suffix=".epub",
        dir=str(epub_file.parent),
        delete=False,
    )
    tmp_path = Path(tmp_handle.name)
    tmp_handle.close()

    written: set[str] = set()
    try:
        with zipfile.ZipFile(tmp_path, "w") as dst:
            for info, payload in entries:
                canonical = _canonical_zip_member(info.filename)
                if canonical in remove_members and canonical not in replacements:
                    continue
                content = replacements.get(canonical, payload)
                if canonical == "mimetype":
                    dst.writestr("mimetype", content, compress_type=zipfile.ZIP_STORED)
                    written.add(canonical)
                    continue
                zinfo = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                zinfo.compress_type = info.compress_type
                zinfo.comment = info.comment
                zinfo.extra = info.extra
                zinfo.internal_attr = info.internal_attr
                zinfo.external_attr = info.external_attr
                zinfo.create_system = info.create_system
                zinfo.create_version = info.create_version
                zinfo.extract_version = info.extract_version
                zinfo.flag_bits = info.flag_bits
                dst.writestr(zinfo, content)
                written.add(canonical)

            for canonical, content in replacements.items():
                if canonical in written:
                    continue
                zinfo = zipfile.ZipInfo(canonical)
                zinfo.compress_type = zipfile.ZIP_DEFLATED
                dst.writestr(zinfo, content)

        tmp_path.replace(epub_file)
        return True
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def _split_chapter_title(title: str, kind: str) -> tuple[Optional[str], str]:
    if kind != "chapter":
        return None, title
    match = CHAPTER_STAMP_RE.match(title or "")
    if not match:
        return None, title
    stamp = match.group(1).strip()
    main_title = match.group(2).strip()
    if not main_title:
        return None, title
    return stamp, main_title


def _render_section(title: str, lines: Iterable[str], lang: str, kind: str = "chapter") -> str:
    paragraphs = []
    for line in lines:
        if not line:
            continue
        paragraphs.append(f"    <p>{html.escape(line)}</p>")
    body = "\n".join(paragraphs) if paragraphs else ""
    stamp, main_title = _split_chapter_title(title, kind)
    heading_parts: list[str] = ["    <header class=\"chapter-header\">"]
    if stamp:
        heading_parts.append(f"      <p class=\"chapter-stamp\">{html.escape(stamp)}</p>")
    heading_parts.append(f"      <h1 class=\"chapter-title\">{html.escape(main_title)}</h1>")
    heading_parts.append("    </header>")
    heading = "\n".join(heading_parts)
    return (
        "<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"{lang}\">\n"
        "  <head>\n"
        "    <meta charset=\"utf-8\" />\n"
        "    <title>{title}</title>\n"
        "    <link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\" />\n"
        "  </head>\n"
        "  <body class=\"{kind}\">\n"
        "{heading}\n"
        "{body}\n"
        "  </body>\n"
        "</html>\n"
    ).format(lang=lang, title=html.escape(title), heading=heading, body=body, kind=kind)


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
    cover_ok = bool(cover_path and cover_path.exists())
    css_requested = css_text is not None
    css_clean = css_text.strip() if isinstance(css_text, str) else ""
    # Keep original chapter XHTML untouched when only OPF metadata changes are required.
    if not cover_ok and not css_requested:
        # Make non-canonical archive members recoverable before patching OPF.
        _read_epub_resilient(epub_file)
        if _update_epub_metadata_opf_only(epub_file, meta, keep_cover=True):
            _normalize_epub_archive_paths(epub_file)
            return
    # For EPUB writeback with cover/css updates, prefer zip-level patching
    # so original chapter head/style can be preserved.
    if _update_epub_preserve_documents(epub_file, meta, cover_path=cover_path, css_text=css_text):
        _normalize_epub_archive_paths(epub_file)
        return

    book = _read_epub_resilient(epub_file)
    _normalize_spine_and_toc(book)
    _clear_metadata(book, keep_cover=not cover_ok)
    _add_metadata(book, meta)
    if cover_ok:
        book.set_cover(cover_path.name, cover_path.read_bytes())
    if css_requested:
        _apply_bindery_css_overlay(book, css_clean)
    epub.write_epub(str(epub_file), book, {"epub3_pages": False})
    _normalize_epub_archive_paths(epub_file)


def build_epub(
    book_data: Book,
    meta: Metadata,
    output_path: Path,
    cover_path: Optional[Path] = None,
    css_text: Optional[str] = None,
) -> None:
    epub_book = epub.EpubBook()
    _add_metadata(epub_book, meta)

    css = css_text.strip() if css_text and css_text.strip() else ""
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
    _normalize_epub_archive_paths(output_path)


def extract_cover(epub_file: Path) -> Optional[tuple[bytes, str]]:
    if not epub_file.exists():
        return None
    book = _read_epub_resilient(epub_file)
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
    book = _read_epub_resilient(epub_file)
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
    # 预览时总是以我们自己的 /book/{id}/epub/... 作为资源基准；
    # 若原文档存在 <base>，可能会把相对资源解析到错误位置（甚至逃逸出 /epub/）。
    html_text = re.sub(r"<base\\b[^>]*>\\s*", "", html_text, flags=re.IGNORECASE)

    # 处理 <head/>（自闭合）这种形式：需要展开成 <head>...</head> 才能放入 <base>。
    match = re.search(r"<head([^>]*)\\s*/>", html_text, flags=re.IGNORECASE)
    if match:
        attrs = match.group(1) or ""
        replacement = f"<head{attrs}>{base_tag}</head>"
        return re.sub(r"<head([^>]*)\\s*/>", replacement, html_text, count=1, flags=re.IGNORECASE)

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
    def is_nav_doc(item: ebooklib.epub.EpubItem) -> bool:
        if isinstance(item, epub.EpubNav):
            return True
        name = (item.get_name() or "").lower()
        if name in {"nav.xhtml", "nav.html"}:
            return True
        return item.get_type() == ebooklib.ITEM_NAVIGATION

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
        if is_nav_doc(item):
            continue
        if item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        items.append(item)
    if items:
        return items
    return [item for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT) if not is_nav_doc(item)]


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


def _toc_entry_title(entry: object) -> Optional[str]:
    title = getattr(entry, "title", None)
    if not title and hasattr(entry, "get_title"):
        try:
            title = entry.get_title()
        except Exception:
            title = None
    if not title:
        return None
    text = str(title).strip()
    return text or None


def _toc_entry_href(entry: object) -> Optional[str]:
    href = getattr(entry, "href", None)
    if not href:
        href = getattr(entry, "file_name", None)
    if not href and hasattr(entry, "get_name"):
        try:
            href = entry.get_name()
        except Exception:
            href = None
    if not href:
        return None
    text = str(href).strip()
    if not text:
        return None
    return text.split("#", 1)[0].strip() or None


def _path_lookup_keys(path: str) -> list[str]:
    normalized = _canonical_zip_member(path)
    if not normalized:
        return []
    keys: list[str] = [normalized]
    if normalized.startswith("EPUB/"):
        keys.append(normalized[5:])
    keys.append(PurePosixPath(normalized).name)
    deduped: list[str] = []
    seen: set[str] = set()
    for key in keys:
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(key)
    return deduped


def _toc_title_index(book: epub.EpubBook) -> dict[str, str]:
    mapping: dict[str, str] = {}

    def register(entry: object) -> None:
        title = _toc_entry_title(entry)
        href = _toc_entry_href(entry)
        if not title or not href:
            return
        for key in _path_lookup_keys(href):
            mapping.setdefault(key, title)

    def walk(entries: list | tuple) -> None:
        for entry in entries:
            if isinstance(entry, tuple) and len(entry) == 2 and isinstance(entry[1], (list, tuple)):
                register(entry[0])
                walk(entry[1])
                continue
            register(entry)

    toc_entries = book.toc if isinstance(book.toc, (list, tuple)) else []
    walk(toc_entries)
    return mapping


def list_epub_sections(epub_file: Path) -> list[EpubSection]:
    book = _read_epub_resilient(epub_file)
    toc_titles = _toc_title_index(book)
    sections: list[EpubSection] = []
    for item in _spine_items(book):
        item_path = item.get_name() or ""
        title = None
        for key in _path_lookup_keys(item_path):
            if key in toc_titles:
                title = toc_titles[key]
                break
        if not title:
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
        sections.append(EpubSection(title=title, item_path=item_path))
    return sections


def load_epub_item(epub_file: Path, item_path: str, base_href: str) -> tuple[bytes, str]:
    book = _read_epub_resilient(epub_file)
    target_path = item_path.lstrip("/")
    target = None
    for item in book.get_items():
        name = (item.get_name() or "").lstrip("/")
        if name == target_path:
            target = item
            break
    if not target:
        raise FileNotFoundError(item_path)
    content = getattr(target, "content", None)
    if content is None:
        content = target.get_content()
    if isinstance(content, str):
        content = content.encode("utf-8")
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

def _apply_bindery_css_overlay(book: epub.EpubBook, css_text: str) -> None:
    css_clean = css_text.strip()
    docs = _spine_items(book)

    doc_dirs: list[PurePosixPath] = []
    for item in docs:
        name = (item.get_name() or "").lstrip("/")
        if not name:
            continue
        doc_dirs.append(PurePosixPath(name).parent)

    package_root = PurePosixPath(".")
    if doc_dirs:
        common = posixpath.commonpath([d.as_posix() for d in doc_dirs]) or "."
        package_root = PurePosixPath(common)
        if package_root.as_posix() in {"", "."}:
            package_root = PurePosixPath(".")
        if package_root.parts and package_root.parts[-1].lower() in {"text", "xhtml", "html"}:
            package_root = package_root.parent if package_root.parent.as_posix() not in {"", "."} else PurePosixPath(".")

    styles_dir = package_root / "Styles"
    css_href = (styles_dir / BINDERY_CSS_NAME).as_posix()
    if css_href.startswith("./"):
        css_href = css_href[2:]

    # 清理旧版本写入的 bindery.css（以前可能放在 Text/ 之下）。
    keep_ids: set[str] = set()
    if css_clean:
        keep_ids.add(f"bindery-css:{css_href}")
    kept: list[ebooklib.epub.EpubItem] = []
    for item in book.get_items():
        item_id = ""
        try:
            item_id = item.get_id() or ""
        except Exception:
            item_id = ""
        if item_id.startswith("bindery-css:") and item_id not in keep_ids:
            continue
        kept.append(item)
    book.items = kept

    if css_clean:
        existing = book.get_item_with_href(css_href)
        if existing and existing.get_type() == ebooklib.ITEM_STYLE:
            existing.set_content(css_clean.encode("utf-8"))
        elif existing:
            # 同名资源存在但不是样式，避免覆盖；改用不冲突的文件名。
            css_href = (styles_dir / "bindery-overlay.css").as_posix()
            if css_href.startswith("./"):
                css_href = css_href[2:]
            style_item = epub.EpubItem(
                uid=f"bindery-css:{css_href}",
                file_name=css_href,
                media_type="text/css",
                content=css_clean.encode("utf-8"),
            )
            book.add_item(style_item)
        else:
            style_item = epub.EpubItem(
                uid=f"bindery-css:{css_href}",
                file_name=css_href,
                media_type="text/css",
                content=css_clean.encode("utf-8"),
            )
            book.add_item(style_item)

    for item in docs:
        # ebooklib 在写 EPUB / 生成 HTML 时会重建 <head>，只保留 item.links。
        # 因此不能通过“字符串注入 <link>”的方式写入样式表链接。
        if not isinstance(item, epub.EpubHtml):
            continue
        item.links = [
            link for link in item.links if PurePosixPath(str(link.get("href") or "")).name != BINDERY_CSS_NAME
        ]
        if css_clean:
            name = (item.get_name() or "").lstrip("/")
            doc_dir = PurePosixPath(name).parent if name else PurePosixPath(".")
            start = doc_dir.as_posix()
            if start in {"", "."}:
                start = "."
            rel_href = posixpath.relpath(css_href, start=start)
            item.add_link(href=rel_href, rel="stylesheet", type="text/css")
