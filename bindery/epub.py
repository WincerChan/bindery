from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from functools import lru_cache
import html
import posixpath
import re
from pathlib import Path, PurePosixPath
import shutil
import tempfile
from typing import Iterable, Optional
import zipfile
import xml.etree.ElementTree as ET
from jinja2 import Environment, FileSystemLoader, select_autoescape
from lxml import etree as LXML_ET

from .models import Book, Metadata, Volume


@dataclass
class EpubSection:
    title: str
    item_path: str


@dataclass
class EpubSectionDocument:
    index: int
    title: str
    item_path: str
    content: bytes
    media_type: str


@dataclass
class _ZipManifestItem:
    item_id: str
    href: str
    media_type: str
    properties: set[str]
    member_path: str


@dataclass
class _BuildSection:
    item_id: str
    title: str
    href: str
    file_name: str
    content: str


BINDERY_CSS_NAME = "bindery.css"
CHAPTER_STAMP_RE = re.compile(
    r"^\s*(第[0-9零〇一二两三四五六七八九十百千万亿\d]+章)\s*[:：、.\-·]?\s*(.+)\s*$"
)
CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"
OPF_NS = "http://www.idpf.org/2007/opf"
DC_NS = "http://purl.org/dc/elements/1.1/"
BINDERY_CSS_BASENAMES = {"bindery.css", "bindery-overlay.css"}
EPUB_TEMPLATES_DIR = Path(__file__).resolve().parent / "epub_templates"


@lru_cache(maxsize=1)
def _epub_template_env() -> Environment:
    return Environment(
        loader=FileSystemLoader(str(EPUB_TEMPLATES_DIR)),
        autoescape=select_autoescape(
            enabled_extensions=("xml", "xhtml", "html"),
            default_for_string=False,
        ),
        trim_blocks=True,
        lstrip_blocks=True,
    )


def _render_epub_template(template_name: str, **context: object) -> str:
    return _epub_template_env().get_template(template_name).render(**context)


def _canonical_zip_member(name: str) -> str:
    normalized = posixpath.normpath((name or "").replace("\\", "/")).lstrip("/")
    while normalized.startswith("../"):
        normalized = normalized[3:]
    return "" if normalized in {"", "."} else normalized


def _clone_zip_info(
    info: zipfile.ZipInfo,
    *,
    filename: Optional[str] = None,
    compress_type: Optional[int] = None,
) -> zipfile.ZipInfo:
    cloned = zipfile.ZipInfo(filename or info.filename, date_time=info.date_time)
    cloned.compress_type = info.compress_type if compress_type is None else compress_type
    cloned.comment = info.comment
    cloned.extra = info.extra
    cloned.internal_attr = info.internal_attr
    cloned.external_attr = info.external_attr
    cloned.create_system = info.create_system
    cloned.create_version = info.create_version
    cloned.extract_version = info.extract_version
    cloned.flag_bits = info.flag_bits
    return cloned


def _copy_zip_member_stream(
    src: zipfile.ZipFile,
    dst: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    output_name: Optional[str] = None,
    compress_type: Optional[int] = None,
    chunk_size: int = 1024 * 1024,
) -> None:
    target_name = output_name or info.filename
    if target_name == "mimetype":
        payload = src.read(info.filename)
        dst.writestr("mimetype", payload, compress_type=zipfile.ZIP_STORED)
        return
    zinfo = _clone_zip_info(info, filename=target_name, compress_type=compress_type)
    with src.open(info.filename, "r") as src_stream:
        with dst.open(zinfo, "w") as dst_stream:
            shutil.copyfileobj(src_stream, dst_stream, chunk_size)


def _normalize_epub_archive_paths(epub_file: Path, expected_missing: str = "") -> bool:
    if not epub_file.exists():
        return False
    expected = _canonical_zip_member(expected_missing)
    expected_name = PurePosixPath(expected).name if expected else ""
    canonical_map: list[tuple[zipfile.ZipInfo, str]] = []
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
            canonical_map.append((info, canonical))
        if not needs_rewrite:
            return False

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
                for info, canonical in canonical_map:
                    if canonical != "mimetype" or canonical in written:
                        continue
                    _copy_zip_member_stream(src, dst, info, output_name="mimetype", compress_type=zipfile.ZIP_STORED)
                    written.add(canonical)

                for info, canonical in canonical_map:
                    if not canonical or canonical in written:
                        continue
                    _copy_zip_member_stream(src, dst, info, output_name=canonical)
                    written.add(canonical)

            tmp_path.replace(epub_file)
            return True
        finally:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)


def _tag_local_name(tag: object) -> str:
    if not tag or not isinstance(tag, str):
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


def _zip_member_index(zf: zipfile.ZipFile) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for info in zf.infolist():
        canonical = _canonical_zip_member(info.filename)
        if canonical and canonical not in mapping:
            mapping[canonical] = info.filename
    return mapping


def _locate_zip_member(index: dict[str, str], member_path: str) -> Optional[tuple[str, str]]:
    canonical = _canonical_zip_member(member_path)
    if not canonical:
        return None
    for candidate in _path_lookup_keys(canonical):
        if candidate in index:
            return candidate, index[candidate]
    normalized = canonical[5:] if canonical.startswith("EPUB/") else f"EPUB/{canonical}"
    for candidate in _path_lookup_keys(normalized):
        if candidate in index:
            return candidate, index[candidate]
    basename = PurePosixPath(canonical).name
    if basename:
        basename_matches = [
            (key, actual)
            for key, actual in index.items()
            if PurePosixPath(key).name == basename
        ]
        if len(basename_matches) == 1:
            return basename_matches[0]
        if len(basename_matches) > 1:
            preferred_suffixes = (
                f"/Text/{basename}",
                f"/text/{basename}",
                f"/{basename}",
            )
            for suffix in preferred_suffixes:
                for key, actual in basename_matches:
                    if key.endswith(suffix):
                        return key, actual
            return basename_matches[0]
    return None


def _read_member_bytes(zf: zipfile.ZipFile, index: dict[str, str], member_path: str) -> Optional[bytes]:
    located = _locate_zip_member(index, member_path)
    if not located:
        return None
    _, actual_name = located
    return zf.read(actual_name)


def _xml_root_from_bytes(raw: bytes) -> LXML_ET._Element:
    parser = LXML_ET.XMLParser(resolve_entities=False, no_network=True, recover=True)
    return LXML_ET.fromstring(raw, parser=parser)


def _opf_root_from_zip(
    zf: zipfile.ZipFile, index: dict[str, str]
) -> tuple[str, LXML_ET._Element]:
    opf_path = _opf_path_from_container(zf)
    opf_raw = _read_member_bytes(zf, index, opf_path)
    if opf_raw is None:
        raise FileNotFoundError(opf_path)
    return opf_path, _xml_root_from_bytes(opf_raw)


def _child_by_local_name(node: LXML_ET._Element, local_name: str) -> Optional[LXML_ET._Element]:
    for child in list(node):
        if _tag_local_name(child.tag) == local_name:
            return child
    return None


def _iter_children_by_local_name(node: LXML_ET._Element, local_name: str) -> list[LXML_ET._Element]:
    return [child for child in list(node) if _tag_local_name(child.tag) == local_name]


def _is_document_media_type(media_type: str) -> bool:
    normalized = (media_type or "").strip().lower()
    return normalized in {"application/xhtml+xml", "text/html"}


def _is_nav_manifest_item(item: _ZipManifestItem) -> bool:
    if "nav" in item.properties:
        return True
    name = Path(item.member_path).name.lower()
    return name in {"nav.xhtml", "nav.html"}


def _resolve_member_relative(from_member: str, href: str) -> str:
    raw = (href or "").split("#", 1)[0].strip()
    if not raw:
        return ""
    from_dir = PurePosixPath(from_member).parent.as_posix()
    base = from_dir if from_dir not in {"", "."} else "."
    return _canonical_zip_member(posixpath.normpath(posixpath.join(base, raw)))


def _manifest_from_opf(opf_path: str, root: LXML_ET._Element) -> tuple[list[_ZipManifestItem], dict[str, _ZipManifestItem]]:
    manifest = root.find(f"{{{OPF_NS}}}manifest")
    if manifest is None:
        manifest = _child_by_local_name(root, "manifest")
    if manifest is None:
        return [], {}

    items: list[_ZipManifestItem] = []
    by_id: dict[str, _ZipManifestItem] = {}
    for node in _iter_children_by_local_name(manifest, "item"):
        href = str(node.attrib.get("href") or "").strip()
        item = _ZipManifestItem(
            item_id=str(node.attrib.get("id") or "").strip(),
            href=href,
            media_type=str(node.attrib.get("media-type") or "").strip().lower(),
            properties={part for part in str(node.attrib.get("properties") or "").split() if part},
            member_path=_resolve_opf_href(opf_path, href) if href else "",
        )
        items.append(item)
        if item.item_id:
            by_id[item.item_id] = item
    return items, by_id


def _spine_document_items(
    root: LXML_ET._Element, manifest_items: list[_ZipManifestItem], items_by_id: dict[str, _ZipManifestItem]
) -> list[_ZipManifestItem]:
    spine = root.find(f"{{{OPF_NS}}}spine")
    if spine is None:
        spine = _child_by_local_name(root, "spine")

    docs: list[_ZipManifestItem] = []
    if spine is not None:
        for itemref in _iter_children_by_local_name(spine, "itemref"):
            idref = str(itemref.attrib.get("idref") or "").strip()
            if not idref:
                continue
            item = items_by_id.get(idref)
            if not item or not _is_document_media_type(item.media_type):
                continue
            if _is_nav_manifest_item(item):
                continue
            docs.append(item)
    if docs:
        return docs
    for item in manifest_items:
        if not _is_document_media_type(item.media_type):
            continue
        if _is_nav_manifest_item(item):
            continue
        docs.append(item)
    return docs


def _node_text(node: Optional[LXML_ET._Element]) -> Optional[str]:
    if node is None:
        return None
    text = "".join(node.itertext()).strip()
    return text or None


def _nav_toc_title_index(
    zf: zipfile.ZipFile, index: dict[str, str], manifest_items: list[_ZipManifestItem]
) -> dict[str, str]:
    mapping: dict[str, str] = {}
    nav_items = [item for item in manifest_items if _is_document_media_type(item.media_type) and _is_nav_manifest_item(item)]
    for nav_item in nav_items:
        nav_raw = _read_member_bytes(zf, index, nav_item.member_path)
        if nav_raw is None:
            continue
        try:
            root = _xml_root_from_bytes(nav_raw)
        except Exception:
            continue
        nav_nodes = root.xpath(".//*[local-name()='nav']")  # noqa: S320
        scoped_links: list[LXML_ET._Element] = []
        for nav in nav_nodes:
            nav_type = ""
            for key, value in nav.attrib.items():
                if _tag_local_name(key) == "type":
                    nav_type = str(value or "").strip().lower()
                    break
            if nav_type and nav_type != "toc":
                continue
            scoped_links.extend(nav.xpath(".//*[local-name()='a'][@href]"))  # noqa: S320
        if not scoped_links:
            scoped_links = root.xpath(".//*[local-name()='a'][@href]")  # noqa: S320
        for link in scoped_links:
            href = str(link.attrib.get("href") or "").strip()
            if not href:
                continue
            target = _resolve_member_relative(nav_item.member_path, href)
            if not target:
                continue
            title = _node_text(link)
            if not title:
                continue
            for key in _path_lookup_keys(target):
                mapping.setdefault(key, title)
    return mapping


def _ncx_toc_title_index(
    zf: zipfile.ZipFile, index: dict[str, str], manifest_items: list[_ZipManifestItem]
) -> dict[str, str]:
    mapping: dict[str, str] = {}
    ncx_items = [
        item
        for item in manifest_items
        if item.media_type == "application/x-dtbncx+xml" or item.href.lower().endswith(".ncx")
    ]
    for ncx_item in ncx_items:
        ncx_raw = _read_member_bytes(zf, index, ncx_item.member_path)
        if ncx_raw is None:
            continue
        try:
            root = _xml_root_from_bytes(ncx_raw)
        except Exception:
            continue
        nav_points = root.xpath(".//*[local-name()='navPoint']")  # noqa: S320
        for point in nav_points:
            label = point.xpath(".//*[local-name()='navLabel']/*[local-name()='text'][1]")  # noqa: S320
            content_nodes = point.xpath(".//*[local-name()='content'][@src][1]")  # noqa: S320
            if not label or not content_nodes:
                continue
            title = _node_text(label[0])
            src = str(content_nodes[0].attrib.get("src") or "").strip()
            if not title or not src:
                continue
            target = _resolve_member_relative(ncx_item.member_path, src)
            if not target:
                continue
            for key in _path_lookup_keys(target):
                mapping.setdefault(key, title)
    return mapping


def _toc_title_index_from_zip(
    zf: zipfile.ZipFile, index: dict[str, str], manifest_items: list[_ZipManifestItem]
) -> dict[str, str]:
    mapping = _nav_toc_title_index(zf, index, manifest_items)
    for key, value in _ncx_toc_title_index(zf, index, manifest_items).items():
        mapping.setdefault(key, value)
    return mapping


def _resolve_document_title(
    zf: zipfile.ZipFile,
    index: dict[str, str],
    item: _ZipManifestItem,
    toc_titles: dict[str, str],
    fallback_index: int,
    content: Optional[bytes] = None,
) -> str:
    title = None
    for key in _path_lookup_keys(item.member_path):
        if key in toc_titles:
            title = toc_titles[key]
            break
    if not title:
        payload = content if content is not None else _read_member_bytes(zf, index, item.member_path)
        if payload:
            title = _extract_title_from_html(payload.decode("utf-8", errors="replace"))
    if not title:
        name = item.href or item.member_path or "section"
        title = Path(name).stem
    return title or f"章节 {fallback_index + 1}"


def _guess_media_type(member_path: str) -> str:
    suffix = Path(member_path).suffix.lower()
    if suffix in {".xhtml", ".html", ".htm"}:
        return "application/xhtml+xml"
    if suffix == ".css":
        return "text/css"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".gif":
        return "image/gif"
    if suffix == ".svg":
        return "image/svg+xml"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".ncx":
        return "application/x-dtbncx+xml"
    return "application/octet-stream"


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


def _strip_stylesheet_links(html_text: str) -> str:
    patterns = [
        r"<link\b[^>]*\brel\s*=\s*['\"][^'\"]*\bstylesheet\b[^'\"]*['\"][^>]*>\s*",
        r"<link\b[^>]*\brel\s*=\s*stylesheet\b[^>]*>\s*",
    ]
    text = html_text
    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)
    return text


def _strip_inline_style_blocks(html_text: str) -> str:
    return re.sub(r"<style\b[^>]*>.*?</style>\s*", "", html_text, flags=re.IGNORECASE | re.DOTALL)


def _strip_xml_stylesheet_pi(html_text: str) -> str:
    return re.sub(r"<\?xml-stylesheet\b[^>]*\?>\s*", "", html_text, flags=re.IGNORECASE)


def _strip_all_css_html(html_text: str) -> str:
    text = _strip_xml_stylesheet_pi(html_text)
    text = _strip_stylesheet_links(text)
    text = _strip_inline_style_blocks(text)
    return text


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


def _patch_doc_html_bindery_css(html_text: str, href: Optional[str], *, strip_original_css: bool = False) -> str:
    if strip_original_css:
        stripped = _strip_all_css_html(html_text)
    else:
        stripped = _strip_bindery_css_links(html_text)
    if not href:
        return stripped
    return _append_stylesheet_link(stripped, href)


def _is_webp_manifest_item(item: ET.Element) -> bool:
    href = str(item.attrib.get("href") or "").strip().lower()
    media_type = str(item.attrib.get("media-type") or "").strip().lower()
    return href.endswith(".webp") or media_type == "image/webp"


def _strip_webp_refs_from_html(html_text: str) -> str:
    # Remove common webp-only media nodes and attributes in XHTML/HTML chapters.
    text = re.sub(
        r"<source\b[^>]*(?:src|srcset)\s*=\s*['\"][^'\"]*\.webp(?:[?#][^'\"]*)?['\"][^>]*>\s*",
        "",
        html_text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"<img\b[^>]*\bsrc\s*=\s*['\"][^'\"]*\.webp(?:[?#][^'\"]*)?['\"][^>]*>\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\s+(?:src|href|poster|data-src)\s*=\s*(['\"])[^'\"]*\.webp(?:[?#][^'\"]*)?\1",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\s+srcset\s*=\s*(['\"])[^'\"]*\.webp[^'\"]*\1",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return text


def strip_webp_assets_and_refs(epub_file: Path) -> bool:
    if not epub_file.exists():
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

        manifest_items = [item for item in list(manifest) if _tag_local_name(item.tag) == "item"]
        remove_members: set[str] = set()
        replacements: dict[str, bytes] = {}
        changed = False

        doc_members: list[str] = []
        for item in manifest_items:
            href = str(item.attrib.get("href") or "").strip()
            media_type = str(item.attrib.get("media-type") or "").strip().lower()
            if href and media_type in {"application/xhtml+xml", "text/html"}:
                member = _resolve_opf_href(opf_path, href)
                if member:
                    doc_members.append(member)

            if _is_webp_manifest_item(item):
                if href:
                    member = _resolve_opf_href(opf_path, href)
                    if member:
                        remove_members.add(member)
                manifest.remove(item)
                changed = True

        for member in doc_members:
            info = next((it for it in infos if _canonical_zip_member(it.filename) == member), None)
            if info is None:
                continue
            original_text = src.read(info.filename).decode("utf-8", errors="replace")
            patched = _strip_webp_refs_from_html(original_text)
            if patched != original_text:
                replacements[member] = patched.encode("utf-8")
                changed = True

        if not changed:
            return False

        replacements[opf_path] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
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
                for info in infos:
                    canonical = _canonical_zip_member(info.filename)
                    if canonical != "mimetype" or canonical in written:
                        continue
                    replacement = replacements.get(canonical)
                    if replacement is not None:
                        dst.writestr("mimetype", replacement, compress_type=zipfile.ZIP_STORED)
                    else:
                        _copy_zip_member_stream(src, dst, info, output_name="mimetype", compress_type=zipfile.ZIP_STORED)
                    written.add(canonical)

                for info in infos:
                    canonical = _canonical_zip_member(info.filename)
                    if not canonical or canonical in written:
                        continue
                    if canonical in remove_members and canonical not in replacements:
                        continue
                    replacement = replacements.get(canonical)
                    if replacement is not None:
                        zinfo = _clone_zip_info(info)
                        dst.writestr(zinfo, replacement)
                    else:
                        _copy_zip_member_stream(src, dst, info)
                    written.add(canonical)

                for canonical, content in replacements.items():
                    if canonical in written:
                        continue
                    if canonical == "mimetype":
                        dst.writestr("mimetype", content, compress_type=zipfile.ZIP_STORED)
                    else:
                        zinfo = zipfile.ZipInfo(canonical)
                        zinfo.compress_type = zipfile.ZIP_DEFLATED
                        dst.writestr(zinfo, content)

            tmp_path.replace(epub_file)
            _normalize_epub_archive_paths(epub_file)
            return True
        finally:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)


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
        for info in infos:
            if _canonical_zip_member(info.filename) == opf_path:
                opf_info = info
                break
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
                # Ensure mimetype is first and stored.
                for info in infos:
                    canonical = _canonical_zip_member(info.filename)
                    if canonical != "mimetype":
                        continue
                    _copy_zip_member_stream(src, dst, info, output_name="mimetype", compress_type=zipfile.ZIP_STORED)
                    break
                for info in infos:
                    canonical = _canonical_zip_member(info.filename)
                    if canonical == "mimetype":
                        continue
                    if canonical == opf_path:
                        zinfo = _clone_zip_info(info)
                        dst.writestr(zinfo, rewritten_opf)
                    else:
                        _copy_zip_member_stream(src, dst, info)
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
    strip_original_css: bool = False,
) -> bool:
    cover_ok = bool(cover_path and cover_path.exists())
    css_requested = css_text is not None
    css_clean = css_text.strip() if isinstance(css_text, str) else ""
    if not cover_ok and not css_requested and not strip_original_css:
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
        if css_requested or strip_original_css:
            removable_css_items: list[ET.Element] = []
            for item in manifest_items:
                item_id = str(item.attrib.get("id") or "")
                href_name = Path(str(item.attrib.get("href") or "")).name.lower()
                media_type = str(item.attrib.get("media-type") or "").strip().lower()
                is_bindery_css = href_name in BINDERY_CSS_BASENAMES or item_id.startswith("bindery-css")
                is_any_css = media_type == "text/css"
                if is_bindery_css or (strip_original_css and is_any_css):
                    removable_css_items.append(item)

            for item in removable_css_items:
                href = str(item.attrib.get("href") or "").strip()
                if href:
                    member = _resolve_opf_href(opf_path, href)
                    if member:
                        remove_members.add(member)
                manifest.remove(item)

            if css_requested and css_clean:
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

        _apply_metadata_to_opf_root(
            root,
            meta,
            keep_cover=not cover_ok,
            cover_meta_id=cover_meta_id,
        )
        replacements[opf_path] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        doc_member_set = set(doc_members)

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
                # Ensure mimetype is first and stored.
                for info in infos:
                    canonical = _canonical_zip_member(info.filename)
                    if canonical != "mimetype" or canonical in written:
                        continue
                    replacement = replacements.get(canonical)
                    if replacement is not None:
                        dst.writestr("mimetype", replacement, compress_type=zipfile.ZIP_STORED)
                    else:
                        _copy_zip_member_stream(src, dst, info, output_name="mimetype", compress_type=zipfile.ZIP_STORED)
                    written.add(canonical)

                for info in infos:
                    canonical = _canonical_zip_member(info.filename)
                    if not canonical or canonical in written:
                        continue
                    if canonical in remove_members and canonical not in replacements:
                        continue

                    if (css_requested or strip_original_css) and canonical in doc_member_set:
                        original_text = src.read(info.filename).decode("utf-8", errors="replace")
                        href = _relative_href(canonical, css_member) if css_member else None
                        patched = _patch_doc_html_bindery_css(
                            original_text,
                            href,
                            strip_original_css=strip_original_css,
                        ).encode("utf-8")
                        zinfo = _clone_zip_info(info)
                        dst.writestr(zinfo, patched)
                        written.add(canonical)
                        continue

                    replacement = replacements.get(canonical)
                    if replacement is not None:
                        zinfo = _clone_zip_info(info)
                        dst.writestr(zinfo, replacement)
                    else:
                        _copy_zip_member_stream(src, dst, info)
                    written.add(canonical)

                for canonical, content in replacements.items():
                    if canonical in written:
                        continue
                    if canonical == "mimetype":
                        dst.writestr("mimetype", content, compress_type=zipfile.ZIP_STORED)
                    else:
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
    paragraphs = [line for line in lines if line]
    stamp, main_title = _split_chapter_title(title, kind)
    return _render_epub_template(
        "section.xhtml.j2",
        lang=lang,
        title=title,
        kind=kind,
        stamp=stamp,
        main_title=main_title,
        paragraphs=paragraphs,
    )


def _render_intro(title: str, author: Optional[str], intro: str, lang: str) -> str:
    paragraphs = [raw.strip() for raw in intro.splitlines() if raw.strip()]
    return _render_epub_template(
        "intro.xhtml.j2",
        lang=lang,
        title=title,
        author=author,
        paragraphs=paragraphs,
    )


def _safe_epub_member_name(filename: str, fallback: str) -> str:
    raw_name = Path(filename or "").name
    cleaned = re.sub(r"[^0-9A-Za-z._-]+", "_", raw_name).strip("._")
    if not cleaned:
        return fallback
    if "." not in cleaned and "." in fallback:
        cleaned = f"{cleaned}{Path(fallback).suffix}"
    return cleaned


def update_epub_metadata(
    epub_file: Path,
    meta: Metadata,
    cover_path: Optional[Path] = None,
    *,
    css_text: Optional[str] = None,
    strip_original_css: bool = False,
    strip_webp_assets: bool = False,
) -> None:
    # Fix non-canonical archive members before any write path.
    _normalize_epub_archive_paths(epub_file)
    if strip_webp_assets:
        strip_webp_assets_and_refs(epub_file)

    cover_ok = bool(cover_path and cover_path.exists())
    css_requested = css_text is not None
    css_clean = css_text.strip() if isinstance(css_text, str) else ""
    # Keep original chapter XHTML untouched when only OPF metadata changes are required.
    if not cover_ok and not css_requested and not strip_original_css:
        if _update_epub_metadata_opf_only(epub_file, meta, keep_cover=True):
            _normalize_epub_archive_paths(epub_file)
            return
    # For EPUB writeback with cover/css updates, prefer zip-level patching
    # so original chapter head/style can be preserved.
    if _update_epub_preserve_documents(
        epub_file,
        meta,
        cover_path=cover_path,
        css_text=css_text,
        strip_original_css=strip_original_css,
    ):
        _normalize_epub_archive_paths(epub_file)
        return
    raise ValueError("Failed to update EPUB metadata using zip/lxml pipeline")


def build_epub(
    book_data: Book,
    meta: Metadata,
    output_path: Path,
    cover_path: Optional[Path] = None,
    css_text: Optional[str] = None,
) -> None:
    lang = meta.language or "zh-CN"
    css = css_text.strip() if css_text and css_text.strip() else ""
    sections: list[_BuildSection] = []
    section_index = 1

    def add_section(title: str, lines: Iterable[str], kind: str = "chapter") -> None:
        nonlocal section_index
        file_name = f"Text/section_{section_index:04d}.xhtml"
        item_id = f"sec{section_index:04d}"
        section_index += 1
        sections.append(
            _BuildSection(
                item_id=item_id,
                title=title,
                href=file_name,
                file_name=file_name,
                content=_render_section(title, lines, lang, kind=kind),
            )
        )

    if book_data.intro:
        intro_file = "Text/section_0000.xhtml"
        sections.append(
            _BuildSection(
                item_id="sec0000",
                title="简介",
                href=intro_file,
                file_name=intro_file,
                content=_render_intro(meta.title, meta.author or book_data.author, book_data.intro, lang),
            )
        )

    for item in book_data.spine:
        if isinstance(item, Volume):
            if item.lines:
                add_section(item.title, item.lines, kind="volume")
            continue
        add_section(item.title, item.lines, kind="chapter")

    if not sections:
        add_section("正文", ["（无内容）"], kind="chapter")

    identifier_value = meta.identifier or meta.book_id
    identifier_urn = identifier_value if str(identifier_value).startswith("urn:") else f"urn:uuid:{identifier_value}"
    modified = (
        dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    tags = [tag for tag in meta.tags if tag]

    cover_href: Optional[str] = None
    cover_media_type: Optional[str] = None
    cover_item_id: Optional[str] = None
    cover_bytes: Optional[bytes] = None
    if cover_path and cover_path.exists():
        cover_name = _safe_epub_member_name(cover_path.name, "cover.jpg")
        cover_href = f"Images/{cover_name}"
        cover_media_type = _guess_image_media_type(cover_name)
        cover_item_id = "cover-image"
        cover_bytes = cover_path.read_bytes()

    container_xml = _render_epub_template("container.xml.j2")
    opf_xml = _render_epub_template(
        "content.opf.j2",
        identifier_urn=identifier_urn,
        identifier=meta.identifier,
        isbn=meta.isbn,
        title=meta.title,
        language=lang,
        author=meta.author,
        description=meta.description,
        publisher=meta.publisher,
        published=meta.published,
        series=meta.series,
        tags=tags,
        rating=meta.rating,
        modified=modified,
        sections=sections,
        cover_href=cover_href,
        cover_media_type=cover_media_type,
        cover_item_id=cover_item_id,
    )
    nav_xhtml = _render_epub_template("nav.xhtml.j2", title=meta.title, lang=lang, sections=sections)
    toc_ncx = _render_epub_template("toc.ncx.j2", title=meta.title, sections=sections)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w") as zf:
        zf.writestr("mimetype", b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", container_xml.encode("utf-8"))
        zf.writestr("EPUB/content.opf", opf_xml.encode("utf-8"))
        zf.writestr("EPUB/nav.xhtml", nav_xhtml.encode("utf-8"))
        zf.writestr("EPUB/toc.ncx", toc_ncx.encode("utf-8"))
        zf.writestr("EPUB/Styles/style.css", css.encode("utf-8"))
        for section in sections:
            zf.writestr(f"EPUB/{section.file_name}", section.content.encode("utf-8"))
        if cover_href and cover_bytes is not None:
            zf.writestr(f"EPUB/{cover_href}", cover_bytes)

    _normalize_epub_archive_paths(output_path)


def extract_cover(epub_file: Path) -> Optional[tuple[bytes, str]]:
    if not epub_file.exists():
        return None
    with zipfile.ZipFile(epub_file, "r") as zf:
        index = _zip_member_index(zf)
        try:
            opf_path, root = _opf_root_from_zip(zf, index)
        except Exception:
            return None
        manifest_items, items_by_id = _manifest_from_opf(opf_path, root)
        metadata = root.find(f"{{{OPF_NS}}}metadata")
        if metadata is None:
            metadata = _child_by_local_name(root, "metadata")

        cover_item: Optional[_ZipManifestItem] = None
        if metadata is not None:
            for node in _iter_children_by_local_name(metadata, "meta"):
                attrs = {_tag_local_name(key): value for key, value in node.attrib.items()}
                if str(attrs.get("name") or "").strip() != "cover":
                    continue
                cover_ref = str(attrs.get("content") or "").strip()
                if cover_ref and cover_ref in items_by_id:
                    candidate = items_by_id[cover_ref]
                    if candidate.media_type.startswith("image/"):
                        cover_item = candidate
                        break
        if cover_item is None:
            for item in manifest_items:
                if item.media_type.startswith("image/") and "cover-image" in item.properties:
                    cover_item = item
                    break
        if cover_item is None:
            for item in manifest_items:
                if not item.media_type.startswith("image/"):
                    continue
                if "cover" in item.item_id.lower() or "cover" in item.member_path.lower():
                    cover_item = item
                    break
        if cover_item is None:
            return None
        payload = _read_member_bytes(zf, index, cover_item.member_path)
        if payload is None:
            return None
        return payload, cover_item.member_path
    return None


def _looks_like_isbn(value: str) -> bool:
    cleaned = re.sub(r"[^0-9Xx]", "", value or "")
    return len(cleaned) in {10, 13}


def extract_epub_metadata(epub_file: Path, fallback_title: str) -> dict:
    with zipfile.ZipFile(epub_file, "r") as zf:
        index = _zip_member_index(zf)
        _, root = _opf_root_from_zip(zf, index)
        metadata = root.find(f"{{{OPF_NS}}}metadata")
        if metadata is None:
            metadata = _child_by_local_name(root, "metadata")

    if metadata is None:
        return {
            "title": fallback_title,
            "author": None,
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

    dc_values: dict[str, list[tuple[str, dict[str, str]]]] = {}
    opf_meta_values: list[tuple[str, dict[str, str]]] = []
    for node in list(metadata):
        local = _tag_local_name(node.tag)
        text = _node_text(node) or ""
        attrs = {_tag_local_name(key): str(value) for key, value in node.attrib.items()}
        if local == "meta":
            opf_meta_values.append((text, attrs))
            continue
        if local in {"identifier", "title", "language", "creator", "description", "publisher", "date", "subject"}:
            dc_values.setdefault(local, []).append((text, attrs))

    def first_dc(name: str) -> Optional[str]:
        for value, _ in dc_values.get(name, []):
            cleaned = value.strip()
            if cleaned:
                return cleaned
        return None

    title = first_dc("title") or fallback_title
    author = first_dc("creator")
    language = first_dc("language") or "zh-CN"
    description = first_dc("description")
    publisher = first_dc("publisher")
    published = first_dc("date")
    tags = [value.strip() for value, _ in dc_values.get("subject", []) if value and value.strip()]

    identifier = None
    isbn = None
    for value, attrs in dc_values.get("identifier", []):
        cleaned = value.strip()
        if not cleaned:
            continue
        id_attr = str(attrs.get("id") or "").strip()
        if id_attr == "isbn" or _looks_like_isbn(cleaned):
            if not isbn:
                isbn = cleaned
            continue
        if id_attr == "identifier" or identifier is None:
            identifier = cleaned

    series = None
    rating = None
    for value, attrs in opf_meta_values:
        prop = str(attrs.get("property") or "").strip()
        name = str(attrs.get("name") or "").strip()
        cleaned = value.strip()
        if prop == "belongs-to-collection" and cleaned:
            series = cleaned
        if name == "rating" and cleaned:
            try:
                rating_value = int(float(cleaned))
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


def list_epub_sections(epub_file: Path) -> list[EpubSection]:
    sections: list[EpubSection] = []
    with zipfile.ZipFile(epub_file, "r") as zf:
        index = _zip_member_index(zf)
        opf_path, root = _opf_root_from_zip(zf, index)
        manifest_items, items_by_id = _manifest_from_opf(opf_path, root)
        toc_titles = _toc_title_index_from_zip(zf, index, manifest_items)
        for idx, item in enumerate(_spine_document_items(root, manifest_items, items_by_id)):
            title = _resolve_document_title(zf, index, item, toc_titles, idx)
            sections.append(EpubSection(title=title, item_path=item.member_path))
    return sections


def list_epub_section_documents(epub_file: Path) -> list[EpubSectionDocument]:
    """Load EPUB once and return spine document payloads for search/analysis."""
    documents: list[EpubSectionDocument] = []
    with zipfile.ZipFile(epub_file, "r") as zf:
        index = _zip_member_index(zf)
        opf_path, root = _opf_root_from_zip(zf, index)
        manifest_items, items_by_id = _manifest_from_opf(opf_path, root)
        toc_titles = _toc_title_index_from_zip(zf, index, manifest_items)
        for idx, item in enumerate(_spine_document_items(root, manifest_items, items_by_id)):
            content = _read_member_bytes(zf, index, item.member_path)
            if content is None:
                continue
            title = _resolve_document_title(zf, index, item, toc_titles, idx, content=content)
            documents.append(
                EpubSectionDocument(
                    index=idx,
                    title=title,
                    item_path=item.member_path,
                    content=content,
                    media_type=item.media_type or "application/octet-stream",
                )
            )
    return documents


def load_epub_item(epub_file: Path, item_path: str, base_href: str) -> tuple[bytes, str]:
    with zipfile.ZipFile(epub_file, "r") as zf:
        index = _zip_member_index(zf)
        target = _locate_zip_member(index, item_path)
        if not target:
            raise FileNotFoundError(item_path)
        canonical_target, actual_target = target
        content = zf.read(actual_target)

        media_type = _guess_media_type(canonical_target)
        try:
            opf_path, root = _opf_root_from_zip(zf, index)
            manifest_items, _ = _manifest_from_opf(opf_path, root)
            for manifest_item in manifest_items:
                if manifest_item.member_path == canonical_target and manifest_item.media_type:
                    media_type = manifest_item.media_type
                    break
        except Exception:
            pass

    if _is_document_media_type(media_type):
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
