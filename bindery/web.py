from __future__ import annotations

import datetime as dt
import html
import json
import logging
import queue
import re
import shutil
import threading
import tempfile
import traceback
import urllib.error
import urllib.request
import urllib.parse
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .auth import SESSION_COOKIE, configured_hash, is_authenticated, sign_in, sign_out, verify_password
from .css import validate_css
from .db import (
    create_job,
    delete_jobs,
    get_job,
    get_reader_progress,
    init_db,
    list_jobs,
    update_job,
    upsert_reader_progress,
)
from .env import read_env
from .epub import (
    build_epub,
    epub_base_href,
    extract_cover,
    extract_epub_metadata,
    list_epub_section_documents,
    list_epub_sections,
    load_epub_item,
    strip_webp_assets_and_refs,
    update_epub_metadata,
)
from .models import Book, Job, Metadata, Volume
from .metadata_lookup import USER_AGENT, LookupMetadata, lookup_book_metadata_candidates
from .parsing import DEFAULT_RULE_CONFIG, decode_text, parse_book
from .rules import RuleTemplateError, get_rule, load_rule_templates, rules_dir, validate_rule_template_json
from .themes import compose_css, get_theme, load_theme_templates, themes_dir
from .storage import (
    archive_book,
    archive_book_dir,
    cover_path,
    delete_book as delete_book_data,
    ensure_book_exists,
    epub_path,
    library_dir,
    list_archived_books,
    list_books,
    load_book,
    load_metadata,
    new_book_id,
    read_source_text,
    save_book,
    save_cover_bytes,
    save_metadata,
    source_path,
    write_source_text,
)

BASE_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"
BOOK_ID_RE = re.compile(r"^[a-f0-9]{32}$")
DEFAULT_THEME_ID = "default"
# 显式声明“保持书籍样式”（仅针对 EPUB 导入书籍有意义）；避免用 `None` 产生歧义。
KEEP_BOOK_THEME_ID = "__book__"
LIBRARY_PAGE_SIZE = 24
INGEST_QUEUE_DIR = ".ingest-queue"
INGEST_STAGE_DIR = ".ingest-stage"
INGEST_STAGE_DIR_ENV = "BINDERY_STAGE_DIR"
DEFAULT_INGEST_STAGE_DIR = Path(tempfile.gettempdir()) / "bindery-ingest-stage"
DOUBAN_REFERER = "https://book.douban.com/"

_ingest_queue: "queue.Queue[dict]" = queue.Queue()
_ingest_worker_started = False
_ingest_worker_lock = threading.Lock()

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
logger = logging.getLogger("bindery.metadata")


@app.on_event("startup")
async def startup() -> None:
    init_db()
    load_rule_templates()
    _ensure_ingest_worker_started()
    print(f"[bindery] password hash configured: {bool(configured_hash())}")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path.startswith("/static") or path.startswith("/login"):
        return await call_next(request)
    session_id = request.cookies.get(SESSION_COOKIE)
    if not is_authenticated(session_id):
        next_url = request.url.path
        redirect_url = f"/login?next={next_url}"
        if request.headers.get("HX-Request") == "true":
            response = HTMLResponse("", status_code=401)
            response.headers["HX-Redirect"] = redirect_url
            return response
        return RedirectResponse(url=redirect_url, status_code=303)
    return await call_next(request)


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _is_htmx(request: Request) -> bool:
    return request.headers.get("HX-Request") == "true"


def _htmx_redirect(url: str) -> HTMLResponse:
    response = HTMLResponse("")
    response.headers["HX-Redirect"] = url
    return response


def _parse_tags(raw: str) -> list[str]:
    if not raw:
        return []
    parts = re.split(r"[，,]", raw)
    return [item.strip() for item in parts if item.strip()]


def _parse_rating(raw: str) -> Optional[int]:
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return max(0, min(5, value))


def _clamp_int(value: object, minimum: int, maximum: int, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if parsed < minimum:
        return minimum
    if parsed > maximum:
        return maximum
    return parsed


def _looks_like_text(data: bytes) -> bool:
    if not data:
        return False
    sample = data[:4096]
    if b"\x00" in sample:
        return False
    bad = 0
    for byte in sample:
        if byte < 9 or (13 < byte < 32):
            bad += 1
    return bad / len(sample) < 0.02


def _is_epub_zip(data: bytes) -> bool:
    if len(data) < 4 or not data.startswith(b"PK"):
        return False
    try:
        with zipfile.ZipFile(BytesIO(data)) as zf:
            names = set(zf.namelist())
            if "mimetype" in names:
                mimetype = zf.read("mimetype").strip()
                if mimetype == b"application/epub+zip":
                    return True
            return "META-INF/container.xml" in names
    except Exception:
        return False


def _detect_source_type_probe(filename: str, content_type: Optional[str], probe: bytes) -> str:
    suffix = Path(filename).suffix.lower() if filename else ""
    if suffix == ".epub":
        return "epub"
    if suffix == ".txt":
        return "txt"
    if content_type == "application/epub+zip":
        return "epub"
    if probe.startswith(b"PK"):
        return "epub"
    if content_type and content_type.startswith("text/"):
        return "txt"
    if _looks_like_text(probe):
        return "txt"
    return "unknown"


def _detect_source_type(filename: str, content_type: Optional[str], data: bytes) -> str:
    suffix = Path(filename).suffix.lower() if filename else ""
    if suffix == ".epub":
        return "epub"
    if suffix == ".txt":
        return "txt"
    if content_type == "application/epub+zip":
        return "epub"
    if _is_epub_zip(data):
        return "epub"
    if content_type and content_type.startswith("text/"):
        return "txt"
    if _looks_like_text(data):
        return "txt"
    return "unknown"


def _read_file_probe(file_path: Path, limit: int = 4096) -> bytes:
    try:
        with file_path.open("rb") as handle:
            return handle.read(limit)
    except FileNotFoundError:
        return b""


async def _stream_upload_to_path(
    upload_file: UploadFile, destination: Path, *, probe_limit: int = 4096, chunk_size: int = 1024 * 1024
) -> tuple[int, bytes]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    probe = bytearray()
    with destination.open("wb") as out:
        while True:
            chunk = await upload_file.read(chunk_size)
            if not chunk:
                break
            out.write(chunk)
            total += len(chunk)
            if len(probe) < probe_limit:
                remaining = probe_limit - len(probe)
                probe.extend(chunk[:remaining])
    return total, bytes(probe)


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "_", value).strip("_")
    return cleaned or "book"


def _normalize_identity_text(value: Optional[str]) -> str:
    cleaned = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", (value or "").strip().lower())
    return cleaned


def _normalize_isbn(value: Optional[str]) -> str:
    return re.sub(r"[^0-9Xx]+", "", (value or "")).upper()


def _match_duplicate_reason(
    candidate_title: Optional[str],
    candidate_author: Optional[str],
    candidate_isbn: Optional[str],
    existing: Metadata,
) -> Optional[str]:
    candidate_isbn_key = _normalize_isbn(candidate_isbn)
    existing_isbn_key = _normalize_isbn(existing.isbn)
    if candidate_isbn_key and existing_isbn_key and candidate_isbn_key == existing_isbn_key:
        return "ISBN"

    candidate_title_key = _normalize_identity_text(candidate_title)
    existing_title_key = _normalize_identity_text(existing.title)
    if not candidate_title_key or not existing_title_key or candidate_title_key != existing_title_key:
        return None

    candidate_author_key = _normalize_identity_text(candidate_author)
    existing_author_key = _normalize_identity_text(existing.author)
    if candidate_author_key and existing_author_key and candidate_author_key == existing_author_key:
        return "标题+作者"
    if not candidate_author_key and not existing_author_key:
        return "标题"
    return None


def _find_duplicate_books(
    base: Path,
    title: Optional[str],
    author: Optional[str],
    isbn: Optional[str],
    *,
    limit: int = 3,
) -> list[dict]:
    matches: list[dict] = []
    for existing in list_books(base):
        reason = _match_duplicate_reason(title, author, isbn, existing)
        if not reason:
            continue
        matches.append(
            {
                "book_id": existing.book_id,
                "title": existing.title,
                "author": existing.author or "未知",
                "reason": reason,
            }
        )
        if len(matches) >= limit:
            break
    return matches


def _find_first_duplicate_meta(
    base: Path,
    title: Optional[str],
    author: Optional[str],
    isbn: Optional[str],
) -> Optional[Metadata]:
    for existing in list_books(base):
        if _match_duplicate_reason(title, author, isbn, existing):
            return existing
    return None


def _book_sections(book: Book) -> list[dict]:
    sections: list[dict] = []
    if book.intro:
        sections.append({"title": "简介", "lines": book.intro.splitlines(), "type": "简介"})
    for item in book.spine:
        if isinstance(item, Volume):
            sections.append({"title": item.title, "lines": list(item.lines), "type": "卷"})
        else:
            sections.append({"title": item.title, "lines": list(item.lines), "type": "章"})
    return sections


def _toc_preview(book: Book, limit: int = 10) -> list[str]:
    titles: list[str] = []
    for item in book.spine:
        if isinstance(item, Volume):
            titles.append(item.title)
        else:
            titles.append(item.title)
        if len(titles) >= limit:
            break
    return titles


def _status_view(meta: Metadata) -> tuple[str, str]:
    if meta.status == "failed":
        return "转换失败", "failed"
    if meta.status == "dirty":
        return "待写回", "pending"
    if meta.epub_updated_at and meta.updated_at and meta.epub_updated_at >= meta.updated_at:
        return "已写回元数据", "ok"
    return "待写回", "pending"


def _job_action_label(action: str) -> str:
    labels = {
        "upload": "上传并转换",
        "upload-epub": "EPUB 入库",
        "edit-writeback": "编辑并写回",
        "regenerate": "重新生成",
        "retry": "重试生成",
        "ingest": "入库检查",
    }
    return labels.get((action or "").strip(), action or "任务")


def _job_view(job: Job, meta_index: dict[str, Metadata]) -> dict:
    meta = meta_index.get(job.book_id or "")
    book_title = meta.title if meta and meta.title else "未关联书籍"
    book_author = meta.author if meta and meta.author else "未知"
    can_open = bool(job.book_id and meta and not meta.archived)
    return {
        "id": job.id,
        "book_id": job.book_id,
        "book_title": book_title,
        "book_author": book_author,
        "can_open_book": can_open,
        "action": job.action,
        "action_label": _job_action_label(job.action),
        "status": job.status,
        "stage": job.stage,
        "message": job.message,
        "log": job.log,
        "rule_template": job.rule_template,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    }


def _job_is_invalid(job: Job, meta_index: dict[str, Metadata]) -> bool:
    book_id = (job.book_id or "").strip()
    if not book_id:
        return True
    return book_id not in meta_index


def _invalid_job_ids(jobs: list[Job], meta_index: dict[str, Metadata]) -> list[str]:
    return [job.id for job in jobs if _job_is_invalid(job, meta_index)]


def _effective_theme_id(meta: Metadata) -> Optional[str]:
    raw = (meta.theme_template or "").strip()
    if meta.source_type == "epub" and raw == KEEP_BOOK_THEME_ID:
        return None
    if raw:
        return raw
    return DEFAULT_THEME_ID


def _compose_css_text(meta: Metadata) -> str:
    theme_id = _effective_theme_id(meta)
    theme_css = get_theme(theme_id).css if theme_id else ""
    return compose_css(theme_css, meta.custom_css)


def _normalize_css_text(text: str) -> str:
    return (text or "").replace("\r\n", "\n").strip()


def _normalize_read_filter(value: str) -> str:
    return "unread" if (value or "").strip().lower() == "unread" else "all"


def _normalize_sort(value: str) -> str:
    return "created" if (value or "").strip().lower() == "created" else "updated"


def _is_true_flag(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if not isinstance(value, str):
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _safe_internal_redirect_target(target: object, fallback: str) -> str:
    raw = target.strip() if isinstance(target, str) else ""
    if not raw:
        return fallback
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme or parsed.netloc:
        return fallback
    path = parsed.path or ""
    if not path.startswith("/") or path.startswith("//"):
        return fallback
    return urllib.parse.urlunparse(("", "", path, "", parsed.query, ""))


def _no_store_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-store, max-age=0",
        "CDN-Cache-Control": "no-store",
        "Pragma": "no-cache",
        "Expires": "0",
    }


def _edge_bypass_browser_revalidate_headers() -> dict[str, str]:
    # Browser may store, but must revalidate with origin; CDN must not cache.
    return {
        "Cache-Control": "private, no-cache, must-revalidate",
        "CDN-Cache-Control": "no-store",
        "Cloudflare-CDN-Cache-Control": "no-store",
        "Pragma": "no-cache",
    }


def _normalize_search_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def _extract_text_from_html_bytes(content: bytes) -> str:
    text = content.decode("utf-8", errors="replace")
    text = re.sub(r"(?is)<script\b[^>]*>.*?</script>", " ", text)
    text = re.sub(r"(?is)<style\b[^>]*>.*?</style>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    return _normalize_search_text(text)


def _search_epub_hits(
    epub_file: Path,
    query: str,
    limit: int,
    offset: int = 0,
) -> tuple[list[dict[str, object]], int, bool, int]:
    # Per request: scan once from spine, avoid repeated read_epub per chapter.
    query_raw = _normalize_search_text(query)
    if not query_raw:
        return [], 0, False, 0
    query_lower = query_raw.lower()
    results: list[dict[str, object]] = []
    indexed_sections = 0
    effective_offset = max(0, int(offset or 0))
    matched_hits = 0
    has_more = False

    for section in list_epub_section_documents(epub_file):
        if "html" not in (section.media_type or "").lower():
            continue
        text = _extract_text_from_html_bytes(section.content)
        if not text:
            continue
        indexed_sections += 1
        text_lower = text.lower()
        match_at = text_lower.find(query_lower)
        if match_at < 0:
            continue
        matched_hits += 1
        if matched_hits <= effective_offset:
            continue
        start = max(0, match_at - 30)
        end = min(len(text), match_at + len(query_raw) + 70)
        snippet = ("..." if start > 0 else "") + text[start:end] + ("..." if end < len(text) else "")
        if len(results) < limit:
            results.append(
                {
                    "index": section.index,
                    "title": section.title,
                    "offset": match_at,
                    "snippet": snippet,
                }
            )
            continue
        has_more = True
    next_offset = effective_offset + len(results)
    return results, indexed_sections, has_more, next_offset


def _library_return_to_url(sort: str, q: str, page: int, read_filter: str) -> str:
    safe_page = max(1, page)
    params = {
        "sort": _normalize_sort(sort),
        "q": q or "",
        "page": str(safe_page),
        "read_filter": _normalize_read_filter(read_filter),
    }
    return f"/?{urllib.parse.urlencode(params)}"


def _is_douban_host(hostname: str) -> bool:
    host = (hostname or "").strip().lower()
    return host in {"douban.com", "doubanio.com"} or host.endswith(".douban.com") or host.endswith(".doubanio.com")


def _download_cover_from_url(cover_url: str, timeout: float = 10.0) -> tuple[bytes, str]:
    url = (cover_url or "").strip()
    if not url:
        raise ValueError("Missing URL")
    parsed = urllib.parse.urlparse(url)
    headers: dict[str, str] = {}
    is_douban = _is_douban_host(parsed.hostname or "")
    if is_douban:
        headers["Referer"] = DOUBAN_REFERER
        headers["User-Agent"] = USER_AGENT
        headers["Accept"] = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
        headers["Accept-Language"] = "zh-CN,zh;q=0.9,en;q=0.8"
        headers["Cache-Control"] = "no-cache"
        headers["Pragma"] = "no-cache"

    request_obj: urllib.request.Request | str
    if headers:
        request_obj = urllib.request.Request(url, headers=headers)
    else:
        request_obj = url

    try:
        with urllib.request.urlopen(request_obj, timeout=timeout) as response:
            data = response.read()
    except urllib.error.HTTPError as exc:
        if is_douban:
            raise ValueError(f"豆瓣封面下载失败（HTTP {exc.code}）: {url}") from exc
        raise ValueError(f"封面下载失败（HTTP {exc.code}）: {url}") from exc
    except urllib.error.URLError as exc:
        if is_douban:
            raise ValueError(f"豆瓣封面下载失败（网络异常）: {exc.reason}") from exc
        raise ValueError(f"封面下载失败（网络异常）: {exc.reason}") from exc
    if not data:
        raise ValueError("封面 URL 下载为空")
    filename = Path(parsed.path).name or "cover"
    return data, filename


def _style_css_path(names: list[str]) -> Optional[str]:
    if "EPUB/style.css" in names:
        return "EPUB/style.css"
    for name in names:
        if name.endswith("/style.css") or name == "style.css":
            return name
    return None


def _overlay_css_paths(names: list[str]) -> list[str]:
    matches = [
        name
        for name in names
        if name.endswith("/Styles/bindery.css")
        or name.endswith("/Styles/bindery-overlay.css")
        or name.endswith("/Text/bindery.css")
        or name.endswith("/bindery.css")
    ]
    return sorted(set(matches))


def _book_epub_needs_css_sync(epub_file: Path, meta: Metadata) -> bool:
    css_text = _compose_css_text(meta)
    with zipfile.ZipFile(epub_file, "r") as zf:
        names = zf.namelist()
        if meta.source_type != "epub":
            style_path = _style_css_path(names)
            if not style_path:
                return True
            expected = css_text if css_text.strip() else ""
            actual = zf.read(style_path).decode("utf-8", errors="replace")
            return _normalize_css_text(actual) != _normalize_css_text(expected)

        overlay_paths = _overlay_css_paths(names)
        if not css_text.strip():
            return bool(overlay_paths)
        if not overlay_paths:
            return True
        actual = zf.read(overlay_paths[0]).decode("utf-8", errors="replace")
        return _normalize_css_text(actual) != _normalize_css_text(css_text)


def _ensure_book_epub_css(base: Path, meta: Metadata) -> None:
    epub_file = epub_path(base, meta.book_id)
    if not epub_file.exists():
        return
    if not _book_epub_needs_css_sync(epub_file, meta):
        return

    css_text = _compose_css_text(meta)
    if meta.source_type == "epub":
        # 不覆盖封面：保持 EPUB 本体。
        update_epub_metadata(epub_file, meta, None, css_text=css_text, strip_webp_assets=True)
    else:
        book = load_book(base, meta.book_id)
        cover_path_obj = cover_path(base, meta.book_id, meta.cover_file) if meta.cover_file else None
        build_epub(book, meta, epub_file, cover_path_obj, css_text=css_text)

    _update_meta_synced(meta)
    save_metadata(meta, base)


def _book_view(meta: Metadata, base: Path) -> dict:
    status_label, status_class = _status_view(meta)
    source_type = meta.source_type or "txt"
    can_regenerate = source_type != "epub" and source_path(base, meta.book_id).exists()
    data = {
        "book_id": meta.book_id,
        "title": meta.title,
        "author": meta.author,
        "language": meta.language,
        "description": meta.description,
        "series": meta.series,
        "identifier": meta.identifier,
        "publisher": meta.publisher,
        "tags": list(meta.tags),
        "published": meta.published,
        "isbn": meta.isbn,
        "rating": meta.rating,
        "status": meta.status,
        "status_label": status_label,
        "status_class": status_class,
        "epub_updated_at": meta.epub_updated_at,
        "archived": meta.archived,
        "read": meta.read,
        "cover_file": meta.cover_file,
        "rule_template": meta.rule_template,
        "theme_template": meta.theme_template,
        "effective_theme_template": _effective_theme_id(meta),
        "custom_css": meta.custom_css,
        "source_type": source_type,
        "can_regenerate": can_regenerate,
        "created_at": meta.created_at,
        "updated_at": meta.updated_at,
        "path": str(base / meta.book_id),
    }
    if meta.cover_file and not meta.archived:
        data["cover_url"] = f"/book/{meta.book_id}/cover"
    return data


def _build_edit_draft_view(
    meta: Metadata,
    base: Path,
    book: Book,
    *,
    title: str,
    author: str,
    language: str,
    description: str,
    series: str,
    publisher: str,
    tags: str,
    published: str,
    isbn: str,
    rating: str,
    rule_template: str,
    theme_template: str,
    custom_css: str,
    cover_url: str,
) -> dict:
    draft = _book_view(meta, base)
    draft["title"] = title.strip() or book.title or meta.title or "未命名"
    draft["author"] = author.strip() or None
    draft["language"] = language.strip() or "zh-CN"
    draft["description"] = description.strip() or None
    draft["series"] = series.strip() or None
    draft["publisher"] = publisher.strip() or None
    draft["tags"] = _parse_tags(tags)
    draft["published"] = published.strip() or None
    draft["isbn"] = isbn.strip() or None
    draft["rating"] = _parse_rating(rating)
    draft["custom_css"] = custom_css.strip() or None
    draft["cover_fetch_url"] = cover_url.strip() or draft.get("cover_fetch_url") or ""

    if meta.source_type != "epub":
        draft["rule_template"] = rule_template.strip() or draft.get("rule_template") or "default"

    raw_theme = theme_template.strip()
    if raw_theme:
        if meta.source_type == "epub" and raw_theme == KEEP_BOOK_THEME_ID:
            draft["theme_template"] = KEEP_BOOK_THEME_ID
            draft["effective_theme_template"] = None
        else:
            selected_theme = raw_theme if raw_theme != KEEP_BOOK_THEME_ID else DEFAULT_THEME_ID
            draft["theme_template"] = selected_theme
            draft["effective_theme_template"] = selected_theme

    return draft


def _lookup_result_view(
    query: str,
    source_name: str,
    draft_book: dict,
    lookup_errors: list[str],
    *,
    source_cover_url: Optional[str] = None,
) -> dict:
    return {
        "query": query,
        "source": source_name,
        "title": draft_book.get("title"),
        "author": draft_book.get("author"),
        "language": draft_book.get("language"),
        "publisher": draft_book.get("publisher"),
        "published": draft_book.get("published"),
        "isbn": draft_book.get("isbn"),
        "cover_url": source_cover_url,
        "applied_cover_url": draft_book.get("cover_fetch_url"),
        "tags": list(draft_book.get("tags") or []),
        "description": draft_book.get("description"),
        "errors": lookup_errors[:2],
    }


def _lookup_source_label(source_id: str) -> str:
    return {"douban": "豆瓣", "amazon": "Amazon"}.get(source_id, source_id)


def _lookup_sources_view(candidates: dict[str, LookupMetadata], selected_source: Optional[str]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for source_id in ("douban", "amazon"):
        if source_id not in candidates:
            continue
        items.append(
            {
                "id": source_id,
                "label": _lookup_source_label(source_id),
                "selected": "true" if source_id == selected_source else "false",
            }
        )
    return items


def _lookup_candidates_payload(candidates: dict[str, LookupMetadata]) -> dict[str, dict]:
    payload: dict[str, dict] = {}
    for source_id, item in candidates.items():
        payload[source_id] = {
            "source": source_id,
            "title": item.title or "",
            "author": item.author or "",
            "language": item.language or "",
            "description": item.description or "",
            "publisher": item.publisher or "",
            "tags": list(item.tags or []),
            "published": item.published or "",
            "isbn": item.isbn or "",
            "cover_url": item.cover_url or "",
        }
    return payload


def _apply_lookup_metadata_to_draft(
    draft_book: dict,
    result: LookupMetadata,
    *,
    allow_cover_fill: bool,
) -> list[str]:
    changed_fields: list[str] = []

    def apply_value(field: str, value: Optional[str]) -> None:
        if not value:
            return
        current = draft_book.get(field)
        if current != value:
            draft_book[field] = value
            changed_fields.append(field)

    apply_value("title", result.title)
    apply_value("author", result.author)
    apply_value("language", result.language)
    apply_value("description", result.description)
    apply_value("publisher", result.publisher)
    apply_value("published", result.published)
    apply_value("isbn", result.isbn)

    if result.tags:
        tags = list(result.tags)
        if list(draft_book.get("tags") or []) != tags:
            draft_book["tags"] = tags
            changed_fields.append("tags")

    if allow_cover_fill and result.source == "douban" and result.cover_url:
        cover_url = result.cover_url.strip()
        current_cover = str(draft_book.get("cover_fetch_url") or "").strip()
        if current_cover != cover_url:
            draft_book["cover_fetch_url"] = cover_url
            changed_fields.append("cover_url")

    return changed_fields


def _require_book(base: Path, book_id: str) -> None:
    if not BOOK_ID_RE.match(book_id):
        raise HTTPException(status_code=404, detail="Invalid book id")
    if not ensure_book_exists(base, book_id):
        raise HTTPException(status_code=404, detail="Book not found")


def _normalize_book_ids(raw_ids: list[str]) -> list[str]:
    selected: list[str] = []
    seen: set[str] = set()
    for raw in raw_ids:
        book_id = (raw or "").strip()
        if not BOOK_ID_RE.match(book_id):
            continue
        if book_id in seen:
            continue
        seen.add(book_id)
        selected.append(book_id)
    return selected


def _require_theme(theme_id: str):
    for theme in load_theme_templates():
        if theme.theme_id == theme_id:
            return theme
    raise HTTPException(status_code=404, detail="Theme not found")


def _require_rule_template(rule_id: str):
    for rule in load_rule_templates():
        if rule.rule_id == rule_id:
            return rule
    raise HTTPException(status_code=404, detail="Rule not found")


def _all_book_meta(base: Path) -> list[Metadata]:
    return list_books(base) + list_archived_books(base)


def _rule_referenced(base: Path, rule_id: str) -> bool:
    for meta in _all_book_meta(base):
        if (meta.rule_template or "").strip() == rule_id:
            return True
    return False


def _theme_referenced(base: Path, theme_id: str) -> bool:
    for meta in _all_book_meta(base):
        if (meta.theme_template or "").strip() == theme_id:
            return True
    return False


def _build_metadata(
    book_id: str,
    book: Book,
    title: str,
    author: str,
    language: str,
    description: str,
    series: str,
    identifier: str,
    publisher: str,
    tags: str,
    published: str,
    isbn: str,
    rating: str,
    rule_template: str,
    theme_template: str,
    custom_css: str,
) -> Metadata:
    now = _now_iso()
    meta_title = title.strip() if title.strip() else (book.title or "未命名")
    meta_author = author.strip() if author.strip() else (book.author or None)
    meta_language = language.strip() if language.strip() else "zh-CN"
    meta_description = description.strip() if description.strip() else (book.intro or None)
    meta_series = series.strip() if series.strip() else None
    meta_identifier = identifier.strip() if identifier.strip() else None
    meta_publisher = publisher.strip() if publisher.strip() else None
    meta_tags = _parse_tags(tags)
    meta_published = published.strip() if published.strip() else None
    meta_isbn = isbn.strip() if isbn.strip() else None
    meta_rating = _parse_rating(rating)
    raw_theme = theme_template.strip()
    meta_theme = raw_theme if raw_theme and raw_theme != KEEP_BOOK_THEME_ID else DEFAULT_THEME_ID
    meta_css = custom_css.strip() if custom_css and custom_css.strip() else None

    return Metadata(
        book_id=book_id,
        title=meta_title,
        author=meta_author,
        language=meta_language,
        description=meta_description,
        source_type="txt",
        series=meta_series,
        identifier=meta_identifier,
        publisher=meta_publisher,
        tags=meta_tags,
        published=meta_published,
        isbn=meta_isbn,
        rating=meta_rating,
        status="dirty",
        epub_updated_at=None,
        archived=False,
        cover_file=None,
        rule_template=rule_template,
        theme_template=meta_theme,
        custom_css=meta_css,
        created_at=now,
        updated_at=now,
    )


def _build_metadata_from_epub(
    book_id: str,
    extracted: dict,
    title: str,
    author: str,
    language: str,
    description: str,
    series: str,
    identifier: str,
    publisher: str,
    tags: str,
    published: str,
    isbn: str,
    rating: str,
    theme_template: str,
    custom_css: str,
) -> Metadata:
    now = _now_iso()

    def pick(value: str, fallback: Optional[str]) -> Optional[str]:
        return value.strip() if value.strip() else fallback

    meta_title = pick(title, extracted.get("title")) or "未命名"
    meta_author = pick(author, extracted.get("author"))
    meta_language = pick(language, extracted.get("language")) or "zh-CN"
    meta_description = pick(description, extracted.get("description"))
    meta_series = pick(series, extracted.get("series"))
    meta_identifier = pick(identifier, extracted.get("identifier"))
    meta_publisher = pick(publisher, extracted.get("publisher"))
    meta_tags = _parse_tags(tags) if tags.strip() else list(extracted.get("tags") or [])
    meta_published = pick(published, extracted.get("published"))
    meta_isbn = pick(isbn, extracted.get("isbn"))
    meta_rating = _parse_rating(rating) if rating.strip() else extracted.get("rating")
    raw_theme = theme_template.strip()
    if raw_theme == KEEP_BOOK_THEME_ID:
        meta_theme = KEEP_BOOK_THEME_ID
    else:
        meta_theme = raw_theme or DEFAULT_THEME_ID
    meta_css = custom_css.strip() if custom_css and custom_css.strip() else None

    return Metadata(
        book_id=book_id,
        title=meta_title,
        author=meta_author,
        language=meta_language,
        description=meta_description,
        source_type="epub",
        series=meta_series,
        identifier=meta_identifier,
        publisher=meta_publisher,
        tags=meta_tags,
        published=meta_published,
        isbn=meta_isbn,
        rating=meta_rating,
        status="synced",
        epub_updated_at=now,
        archived=False,
        cover_file=None,
        rule_template=None,
        theme_template=meta_theme,
        custom_css=meta_css,
        created_at=now,
        updated_at=now,
    )


def _update_meta_synced(meta: Metadata) -> None:
    now = _now_iso()
    meta.status = "synced"
    meta.epub_updated_at = now
    meta.updated_at = now


def _update_meta_failed(meta: Metadata) -> None:
    meta.status = "failed"
    meta.updated_at = _now_iso()


def _create_job(action: str, book_id: Optional[str], rule_template: Optional[str]) -> Job:
    now = _now_iso()
    job = Job(
        id=new_book_id(),
        book_id=book_id,
        action=action,
        status="running",
        stage="预处理",
        message=None,
        log=None,
        rule_template=rule_template,
        created_at=now,
        updated_at=now,
    )
    create_job(job)
    return job


def _update_job(job_id: str, **fields: object) -> None:
    fields["updated_at"] = _now_iso()
    update_job(job_id, **fields)


def _queue_payload_path(base: Path, job_id: str, filename: str) -> Path:
    queue_dir = base / INGEST_QUEUE_DIR / job_id
    queue_dir.mkdir(parents=True, exist_ok=True)
    raw_name = Path(filename or "upload")
    suffix = raw_name.suffix.lower() or ".bin"
    stem = _safe_filename(raw_name.stem or "upload")
    return queue_dir / f"{stem}{suffix}"


def _persist_queued_upload(base: Path, job_id: str, filename: str, data: bytes) -> Path:
    payload_path = _queue_payload_path(base, job_id, filename)
    payload_path.write_bytes(data)
    return payload_path


async def _persist_queued_upload_stream(base: Path, job_id: str, upload_file: UploadFile) -> tuple[Path, int, bytes]:
    payload_path = _queue_payload_path(base, job_id, upload_file.filename or "upload")
    size, probe = await _stream_upload_to_path(upload_file, payload_path)
    return payload_path, size, probe


def _staged_upload_dir(_base: Path) -> Path:
    env_value = read_env(INGEST_STAGE_DIR_ENV)
    stage_dir = Path(env_value) if env_value else DEFAULT_INGEST_STAGE_DIR
    stage_dir.mkdir(parents=True, exist_ok=True)
    return stage_dir


def _persist_staged_upload(
    base: Path,
    filename: str,
    data: bytes,
    content_type: Optional[str],
    kind: str,
) -> str:
    token = new_book_id()
    staged_dir = _staged_upload_dir(base) / token
    staged_dir.mkdir(parents=True, exist_ok=True)
    raw_name = Path(filename or "upload")
    suffix = raw_name.suffix.lower() or ".bin"
    stem = _safe_filename(raw_name.stem or "upload")
    payload_name = f"{stem}{suffix}"
    payload_path = staged_dir / payload_name
    payload_path.write_bytes(data)
    meta = {
        "filename": filename or "upload",
        "content_type": content_type or "",
        "kind": kind,
        "payload_name": payload_name,
    }
    (staged_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False),
        encoding="utf-8",
    )
    return token


async def _persist_staged_upload_stream(base: Path, upload_file: UploadFile) -> tuple[str, str, str, Optional[str], Path, int]:
    token = new_book_id()
    staged_dir = _staged_upload_dir(base) / token
    staged_dir.mkdir(parents=True, exist_ok=True)
    filename = upload_file.filename or "upload"
    raw_name = Path(filename)
    suffix = raw_name.suffix.lower() or ".bin"
    stem = _safe_filename(raw_name.stem or "upload")
    payload_name = f"{stem}{suffix}"
    payload_path = staged_dir / payload_name
    size, probe = await _stream_upload_to_path(upload_file, payload_path)
    content_type = upload_file.content_type
    kind = _detect_source_type_probe(filename, content_type, probe)
    meta = {
        "filename": filename,
        "content_type": content_type or "",
        "kind": kind,
        "payload_name": payload_name,
    }
    (staged_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False),
        encoding="utf-8",
    )
    return token, filename, kind, content_type, payload_path, size


def _load_staged_upload(base: Path, token: str) -> Optional[dict]:
    normalized = (token or "").strip().lower()
    if not BOOK_ID_RE.match(normalized):
        return None
    staged_dir = _staged_upload_dir(base) / normalized
    meta_path = staged_dir / "meta.json"
    if not meta_path.exists():
        return None
    try:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    payload_name = str(payload.get("payload_name") or "").strip()
    if not payload_name or Path(payload_name).name != payload_name:
        return None
    payload_path = staged_dir / payload_name
    if not payload_path.exists():
        return None
    filename = str(payload.get("filename") or payload_name).strip() or payload_name
    content_type = str(payload.get("content_type") or "").strip() or None
    kind = str(payload.get("kind") or "").strip()
    if not kind:
        kind = _detect_source_type_probe(filename, content_type, _read_file_probe(payload_path))
    return {
        "token": normalized,
        "filename": filename,
        "content_type": content_type,
        "kind": kind,
        "payload_path": payload_path,
        "size": payload_path.stat().st_size,
    }


def _move_staged_payload_to_queue(base: Path, token: str, job_id: str, filename: str) -> Optional[Path]:
    staged = _load_staged_upload(base, token)
    if not staged:
        return None
    payload_path_obj = staged.get("payload_path")
    if not isinstance(payload_path_obj, Path):
        return None
    if not payload_path_obj.exists():
        return None
    destination = _queue_payload_path(base, job_id, filename)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(payload_path_obj), str(destination))
    return destination


def _cleanup_staged_upload(base: Path, token: str) -> None:
    normalized = (token or "").strip().lower()
    if not BOOK_ID_RE.match(normalized):
        return
    staged_dir = _staged_upload_dir(base) / normalized
    try:
        shutil.rmtree(staged_dir)
    except FileNotFoundError:
        return
    except Exception:
        return


def _cleanup_staged_uploads_except(base: Path, keep_tokens: Optional[list[str]] = None) -> int:
    keep_set = set(_normalize_upload_tokens(keep_tokens))
    stage_root = _staged_upload_dir(base)
    removed = 0
    for child in stage_root.iterdir():
        if not child.is_dir():
            continue
        token = child.name.strip().lower()
        if token in keep_set:
            continue
        try:
            shutil.rmtree(child)
            removed += 1
        except OSError:
            continue
    return removed


def _normalize_upload_tokens(raw_tokens: Optional[list[str]]) -> list[str]:
    if not raw_tokens:
        return []
    seen: set[str] = set()
    result: list[str] = []
    for raw in raw_tokens:
        token = (raw or "").strip().lower()
        if not BOOK_ID_RE.match(token):
            continue
        if token in seen:
            continue
        seen.add(token)
        result.append(token)
    return result


def _cleanup_queued_upload(payload_path: Path) -> None:
    try:
        payload_path.unlink(missing_ok=True)
    except Exception:
        pass
    parent = payload_path.parent
    try:
        parent.rmdir()
    except OSError:
        return


def _queued_job_spec(kind: str, rule_template: str) -> tuple[str, Optional[str], Optional[str]]:
    if kind == "txt":
        return "upload", new_book_id(), rule_template
    if kind == "epub":
        return "upload-epub", new_book_id(), None
    return "ingest", None, rule_template


def _process_queued_ingest_task(task: dict) -> None:
    job_id = str(task.get("job_id") or "").strip()
    if not job_id:
        return
    job = get_job(job_id)
    if not job:
        return

    base = library_dir()
    kind = str(task.get("kind") or "unknown")
    if kind == "edit-writeback":
        book_id = str(task.get("book_id") or job.book_id or "").strip()
        if not book_id:
            _update_job(job_id, status="failed", stage="失败", message="缺少书籍 ID")
            return
        cover_bytes = task.get("cover_bytes")
        cover_name = task.get("cover_name")
        cover_url = str(task.get("cover_url") or "").strip()
        strip_original_css = bool(task.get("strip_original_css"))
        try:
            _run_edit_writeback(
                job,
                base,
                book_id,
                cover_bytes=cover_bytes if isinstance(cover_bytes, bytes) else None,
                cover_name=cover_name if isinstance(cover_name, str) else None,
                cover_url=cover_url,
                strip_original_css=strip_original_css,
            )
        except Exception:
            current = get_job(job_id)
            if current and current.status == "running":
                _update_job(job_id, status="failed", stage="失败", message="后台处理失败", log=traceback.format_exc())
        return

    payload_path = Path(str(task.get("payload_path") or ""))
    try:
        size = payload_path.stat().st_size
    except Exception:
        _update_job(job_id, status="failed", stage="失败", message="读取队列文件失败")
        _cleanup_queued_upload(payload_path)
        return
    if size <= 0:
        _update_job(job_id, status="failed", stage="失败", message="上传文件为空")
        _cleanup_queued_upload(payload_path)
        return

    filename = str(task.get("filename") or "upload")
    content_type = task.get("content_type")
    detected_kind = _detect_source_type_probe(
        filename, content_type if isinstance(content_type, str) else None, _read_file_probe(payload_path)
    )
    if detected_kind != kind:
        kind = detected_kind

    title = str(task.get("title") or "")
    author = str(task.get("author") or "")
    language = str(task.get("language") or "")
    description = str(task.get("description") or "")
    series = str(task.get("series") or "")
    identifier = str(task.get("identifier") or "")
    publisher = str(task.get("publisher") or "")
    tags = str(task.get("tags") or "")
    published = str(task.get("published") or "")
    isbn = str(task.get("isbn") or "")
    rating = str(task.get("rating") or "")
    rule_template = str(task.get("rule_template") or "default")
    theme_template = str(task.get("theme_template") or "")
    custom_css = str(task.get("custom_css") or "")
    dedupe_mode = "normalize" if str(task.get("dedupe_mode") or "keep") == "normalize" else "keep"
    cover_bytes = task.get("cover_bytes")
    cover_name = task.get("cover_name")

    try:
        if kind == "epub":
            if dedupe_mode == "normalize":
                try:
                    extracted = extract_epub_metadata(payload_path, Path(filename).stem)
                    duplicate_meta = _find_first_duplicate_meta(
                        base,
                        title.strip() or extracted.get("title") or Path(filename).stem,
                        author.strip() or extracted.get("author"),
                        isbn.strip() or extracted.get("isbn"),
                    )
                    if duplicate_meta:
                        _update_job(
                            job_id,
                            book_id=duplicate_meta.book_id,
                            status="success",
                            stage="完成",
                            message="归一到已入库书籍",
                        )
                        return
                except Exception:
                    pass
            meta = _run_epub_ingest(
                job,
                base,
                payload_path,
                filename,
                title,
                author,
                language,
                description,
                series,
                identifier,
                publisher,
                tags,
                published,
                isbn,
                rating,
                theme_template,
                custom_css,
                cover_bytes if isinstance(cover_bytes, bytes) else None,
                cover_name if isinstance(cover_name, str) else None,
            )
            _update_job(job_id, book_id=meta.book_id)
            return

        if kind == "txt":
            text = decode_text(payload_path.read_bytes())
            if not text.strip():
                _update_job(job_id, status="failed", stage="失败", message=f"{filename}: 文本为空或无法解码", log=None)
                return
            source_name = Path(filename).stem
            if dedupe_mode == "normalize":
                try:
                    dedupe_rule = get_rule(rule_template)
                    dedupe_book = parse_book(text, source_name, dedupe_rule.rules)
                    duplicate_meta = _find_first_duplicate_meta(
                        base,
                        title.strip() or dedupe_book.title,
                        author.strip() or dedupe_book.author,
                        isbn.strip() or None,
                    )
                    if duplicate_meta:
                        _update_job(
                            job_id,
                            book_id=duplicate_meta.book_id,
                            status="success",
                            stage="完成",
                            message="归一到已入库书籍",
                        )
                        return
                except RuleTemplateError:
                    pass
                except Exception:
                    pass
            meta = _run_ingest(
                job,
                base,
                text,
                source_name,
                title,
                author,
                language,
                description,
                series,
                identifier,
                publisher,
                tags,
                published,
                isbn,
                rating,
                rule_template,
                theme_template,
                custom_css,
                cover_bytes if isinstance(cover_bytes, bytes) else None,
                cover_name if isinstance(cover_name, str) else None,
            )
            _update_job(job_id, book_id=meta.book_id)
            return

        _update_job(job_id, status="failed", stage="失败", message=f"{filename}: 不支持的文件类型", log=None)
    except Exception:
        current = get_job(job_id)
        if current and current.status == "running":
            _update_job(job_id, status="failed", stage="失败", message="后台处理失败", log=traceback.format_exc())
    finally:
        _cleanup_queued_upload(payload_path)


def _ingest_worker_loop() -> None:
    while True:
        task = _ingest_queue.get()
        try:
            _process_queued_ingest_task(task)
        except Exception:
            logger.exception("ingest worker crashed while processing task")
        finally:
            _ingest_queue.task_done()


def _ensure_ingest_worker_started() -> None:
    global _ingest_worker_started
    with _ingest_worker_lock:
        if _ingest_worker_started:
            return
        worker = threading.Thread(target=_ingest_worker_loop, name="bindery-ingest-worker", daemon=True)
        worker.start()
        _ingest_worker_started = True


def _run_ingest(
    job: Job,
    base: Path,
    text: str,
    source_name: str,
    title: str,
    author: str,
    language: str,
    description: str,
    series: str,
    identifier: str,
    publisher: str,
    tags: str,
    published: str,
    isbn: str,
    rating: str,
    rule_template: str,
    theme_template: str,
    custom_css: str,
    cover_bytes: Optional[bytes],
    cover_name: Optional[str],
) -> Metadata:
    try:
        rule = get_rule(rule_template)
        _update_job(job.id, stage="预处理")
        book = parse_book(text, source_name, rule.rules)
        _update_job(job.id, stage="写元数据")

        book_id = job.book_id or new_book_id()
        job.book_id = book_id
        meta = _build_metadata(
            book_id,
            book,
            title,
            author,
            language,
            description,
            series,
            identifier,
            publisher,
            tags,
            published,
            isbn,
            rating,
            rule_template,
            theme_template,
            custom_css,
        )

        save_book(book, base, book_id)
        save_metadata(meta, base)
        write_source_text(base, book_id, text)

        cover_file = None
        if cover_bytes:
            cover_file = save_cover_bytes(base, book_id, cover_bytes, cover_name)
            meta.cover_file = cover_file

        cover_file = meta.cover_file
        cover_path_obj = cover_path(base, book_id, cover_file) if cover_file else None

        _update_job(job.id, stage="生成 EPUB")
        css_text = _compose_css_text(meta)
        build_epub(book, meta, epub_path(base, book_id), cover_path_obj, css_text=css_text)
        _update_meta_synced(meta)
        save_metadata(meta, base)
        _update_job(job.id, status="success", stage="完成", message="完成")
        return meta
    except Exception:
        _update_job(job.id, status="failed", stage="失败", message="转换失败", log=traceback.format_exc())
        raise


def _run_epub_ingest(
    job: Job,
    base: Path,
    epub_source: Path | bytes,
    filename: str,
    title: str,
    author: str,
    language: str,
    description: str,
    series: str,
    identifier: str,
    publisher: str,
    tags: str,
    published: str,
    isbn: str,
    rating: str,
    theme_template: str,
    custom_css: str,
    cover_bytes: Optional[bytes],
    cover_name: Optional[str],
) -> Metadata:
    try:
        _update_job(job.id, stage="导入 EPUB")
        book_id = job.book_id or new_book_id()
        job.book_id = book_id

        epub_file = epub_path(base, book_id)
        epub_file.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(epub_source, Path):
            shutil.copy2(epub_source, epub_file)
        else:
            epub_file.write_bytes(epub_source)
        strip_webp_assets_and_refs(epub_file)

        extracted = extract_epub_metadata(epub_file, Path(filename or "upload").stem)
        meta = _build_metadata_from_epub(
            book_id,
            extracted,
            title,
            author,
            language,
            description,
            series,
            identifier,
            publisher,
            tags,
            published,
            isbn,
            rating,
            theme_template,
            custom_css,
        )

        save_book(Book(title=meta.title, author=meta.author, intro=None), base, book_id)
        save_metadata(meta, base)

        if cover_bytes:
            meta.cover_file = save_cover_bytes(base, book_id, cover_bytes, cover_name)
        else:
            extracted_cover = extract_cover(epub_file)
            if extracted_cover:
                cover_data, cover_filename = extracted_cover
                meta.cover_file = save_cover_bytes(base, book_id, cover_data, cover_filename)

        cover_path_obj = cover_path(base, book_id, meta.cover_file) if meta.cover_file else None
        css_text = _compose_css_text(meta)
        override_fields = [title, author, language, description, series, identifier, publisher, tags, published, isbn]
        needs_rewrite = any(value.strip() for value in override_fields if isinstance(value, str))
        if rating.strip() or cover_bytes:
            needs_rewrite = True
        if css_text:
            needs_rewrite = True

        if needs_rewrite:
            _update_job(job.id, stage="写回 EPUB")
            update_epub_metadata(epub_file, meta, cover_path_obj, css_text=css_text, strip_webp_assets=True)

        _update_meta_synced(meta)
        save_metadata(meta, base)
        _update_job(job.id, status="success", stage="完成", message="完成")
        return meta
    except Exception:
        _update_job(job.id, status="failed", stage="失败", message="导入失败", log=traceback.format_exc())
        raise


def _run_edit_writeback(
    job: Job,
    base: Path,
    book_id: str,
    *,
    cover_bytes: Optional[bytes],
    cover_name: Optional[str],
    cover_url: str,
    strip_original_css: bool,
) -> Metadata:
    try:
        _update_job(job.id, stage="写元数据")
        meta = load_metadata(base, book_id)
        book = load_book(base, book_id)
        cover_changed = False
        cover_path_obj: Optional[Path] = None

        if cover_bytes:
            meta.cover_file = save_cover_bytes(base, book_id, cover_bytes, cover_name)
            cover_path_obj = cover_path(base, book_id, meta.cover_file)
            cover_changed = True
        elif cover_url:
            _update_job(job.id, stage="下载封面")
            downloaded, resolved_name = _download_cover_from_url(cover_url)
            meta.cover_file = save_cover_bytes(base, book_id, downloaded, resolved_name)
            cover_path_obj = cover_path(base, book_id, meta.cover_file)
            cover_changed = True

        epub_file = epub_path(base, book_id)
        if meta.source_type != "epub":
            if not cover_changed and epub_file.exists():
                extracted_cover = None
                extracted_cover_error = False
                try:
                    extracted_cover = extract_cover(epub_file)
                except Exception:
                    extracted_cover_error = True
                if extracted_cover:
                    cover_data, extracted_name = extracted_cover
                    meta.cover_file = save_cover_bytes(base, book_id, cover_data, extracted_name)
                elif not extracted_cover_error:
                    meta.cover_file = None
            if meta.cover_file:
                cover_path_obj = cover_path(base, book_id, meta.cover_file)

        _update_job(job.id, stage="写回 EPUB")
        if meta.source_type == "epub":
            update_epub_metadata(
                epub_file,
                meta,
                cover_path_obj if cover_changed else None,
                css_text=_compose_css_text(meta),
                strip_original_css=strip_original_css,
                strip_webp_assets=True,
            )
        else:
            build_epub(book, meta, epub_file, cover_path_obj, css_text=_compose_css_text(meta))

        _update_job(job.id, stage="刷新封面")
        extracted_cover = None
        extracted_cover_error = False
        try:
            extracted_cover = extract_cover(epub_file)
        except Exception:
            extracted_cover_error = True
        if extracted_cover:
            cover_data, extracted_name = extracted_cover
            meta.cover_file = save_cover_bytes(base, book_id, cover_data, extracted_name)
        elif not extracted_cover_error:
            meta.cover_file = None

        _update_meta_synced(meta)
        save_metadata(meta, base)
        _update_job(job.id, status="success", stage="完成", message="完成")
        return meta
    except Exception:
        try:
            meta = load_metadata(base, book_id)
            _update_meta_failed(meta)
            save_metadata(meta, base)
        except Exception:
            pass
        _update_job(job.id, status="failed", stage="失败", message="写回失败", log=traceback.format_exc())
        raise


def _run_regenerate(
    job: Job,
    base: Path,
    book_id: str,
    rule_template: str,
) -> Metadata:
    try:
        _update_job(job.id, stage="预处理")
        meta = load_metadata(base, book_id)
        if meta.source_type == "epub":
            raise ValueError("EPUB import cannot regenerate")
        if not source_path(base, book_id).exists():
            raise FileNotFoundError("Source missing")
        text = read_source_text(base, book_id)
        rule = get_rule(rule_template)
        book = parse_book(text, book_id, rule.rules)
        meta.rule_template = rule_template
        meta.status = "dirty"
        meta.updated_at = _now_iso()
        save_book(book, base, book_id)
        save_metadata(meta, base)

        _update_job(job.id, stage="生成 EPUB")
        cover_file = meta.cover_file
        cover_path_obj = cover_path(base, book_id, cover_file) if cover_file else None
        css_text = _compose_css_text(meta)
        build_epub(book, meta, epub_path(base, book_id), cover_path_obj, css_text=css_text)
        _update_meta_synced(meta)
        save_metadata(meta, base)
        _update_job(job.id, status="success", stage="完成", message="完成")
        return meta
    except Exception:
        meta = load_metadata(base, book_id)
        _update_meta_failed(meta)
        save_metadata(meta, base)
        _update_job(job.id, status="failed", stage="失败", message="转换失败", log=traceback.format_exc())
        raise


@app.get("/login", response_class=HTMLResponse)
async def login(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "login.html",
        {
            "request": request,
            "hash_configured": bool(configured_hash()),
            "next": request.query_params.get("next", "/"),
            "error": request.query_params.get("error"),
        },
    )


@app.post("/login")
async def login_post(request: Request, password: str = Form(""), next: str = Form("/")):
    if not configured_hash():
        return RedirectResponse(url="/login?error=未配置密码哈希", status_code=303)
    if not verify_password(password):
        return RedirectResponse(url="/login?error=密码错误", status_code=303)
    session_id = sign_in()
    response = RedirectResponse(url=next or "/", status_code=303)
    response.set_cookie(SESSION_COOKIE, session_id, httponly=True, samesite="lax")
    return response


@app.post("/logout")
async def logout(request: Request) -> RedirectResponse:
    session_id = request.cookies.get(SESSION_COOKIE)
    sign_out(session_id)
    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(SESSION_COOKIE)
    return response


def _library_page_data(base: Path, sort: str, q: str, page: int, read_filter: str) -> dict:
    all_books = list_books(base, sort_output=False)
    selected_read_filter = _normalize_read_filter(read_filter)
    query_text = q.strip().lower()
    books = []
    for book in all_books:
        if query_text:
            title = (book.title or "").lower()
            author = (book.author or "").lower()
            if query_text not in title and query_text not in author:
                continue
        if selected_read_filter == "unread" and book.read:
            continue
        books.append(book)
    if sort == "created":
        books.sort(key=lambda item: item.created_at, reverse=True)
    else:
        books.sort(key=lambda item: item.updated_at or item.created_at, reverse=True)

    total_books = len(books)
    total_pages = max(1, (total_books + LIBRARY_PAGE_SIZE - 1) // LIBRARY_PAGE_SIZE)
    current_page = min(max(1, page), total_pages)
    start = (current_page - 1) * LIBRARY_PAGE_SIZE
    page_books = books[start : start + LIBRARY_PAGE_SIZE]
    view_books = [_book_view(book, base) for book in page_books]

    return {
        "books": view_books,
        "total_books": total_books,
        "page": current_page,
        "total_pages": total_pages,
        "has_prev": current_page > 1,
        "has_next": current_page < total_pages,
        "prev_page": current_page - 1,
        "next_page": current_page + 1,
        "read_filter": selected_read_filter,
    }


@app.get("/", response_class=HTMLResponse)
async def index(
    request: Request,
    sort: str = "updated",
    q: str = "",
    page: int = 1,
    read_filter: str = "all",
) -> HTMLResponse:
    base = library_dir()
    selected_sort = _normalize_sort(sort)
    payload = _library_page_data(base, selected_sort, q, page, read_filter)
    return_to = _library_return_to_url(selected_sort, q, payload["page"], payload["read_filter"])
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "sort": selected_sort, "q": q, "return_to": return_to, **payload},
    )


@app.get("/ingest", response_class=HTMLResponse)
async def ingest_view(request: Request) -> HTMLResponse:
    rules = load_rule_templates()
    themes = load_theme_templates()
    return templates.TemplateResponse(
        "ingest.html",
        {"request": request, "rules": rules, "themes": themes},
    )


@app.post("/ingest/preview", response_class=HTMLResponse)
async def ingest_preview(
    request: Request,
    files: list[UploadFile] = File(...),
    rule_template: str = Form("default"),
    theme_template: str = Form(""),
) -> HTMLResponse:
    previews: list[dict] = []
    base = library_dir()
    _cleanup_staged_uploads_except(base)
    rule = None

    for file in files:
        token, filename, kind, _content_type, payload_path, size = await _persist_staged_upload_stream(base, file)
        upload_token = token
        if size <= 0:
            _cleanup_staged_upload(base, upload_token)
            previews.append(
                {
                    "filename": filename,
                    "format": "未知",
                    "title": None,
                    "author": None,
                    "volumes": 0,
                    "chapters": 0,
                    "toc": [],
                    "output": "—",
                    "path": str(base / "<自动ID>"),
                    "error": "空文件",
                    "duplicates": [],
                    "upload_token": None,
                }
            )
            continue

        if kind == "epub":
            try:
                meta = extract_epub_metadata(payload_path, Path(filename).stem)
                sections = list_epub_sections(payload_path)
            except Exception:
                previews.append(
                    {
                        "filename": filename,
                        "format": "EPUB",
                        "title": None,
                        "author": None,
                        "volumes": 0,
                        "chapters": 0,
                        "toc": [],
                        "output": filename,
                        "path": str(base / "<自动ID>"),
                        "error": "解析 EPUB 失败",
                        "duplicates": [],
                        "upload_token": upload_token,
                    }
                )
                continue
            duplicates = _find_duplicate_books(base, meta.get("title"), meta.get("author"), meta.get("isbn"))
            previews.append(
                {
                    "filename": filename,
                    "format": "EPUB",
                    "title": meta.get("title"),
                    "author": meta.get("author"),
                    "volumes": 0,
                    "chapters": len(sections),
                    "toc": [section.title for section in sections[:10]],
                    "output": filename,
                    "path": str(base / "<自动ID>"),
                    "duplicates": duplicates,
                    "upload_token": upload_token,
                }
            )
            continue

        if kind == "txt":
            if rule is None:
                rule = get_rule(rule_template)
            data = payload_path.read_bytes()
            text = decode_text(data)
            if not text.strip():
                previews.append(
                    {
                        "filename": filename,
                        "format": "TXT",
                        "title": None,
                        "author": None,
                        "volumes": 0,
                        "chapters": 0,
                        "toc": [],
                        "output": "—",
                        "path": str(base / "<自动ID>"),
                        "error": "文本为空或无法解码",
                        "duplicates": [],
                        "upload_token": upload_token,
                    }
                )
                continue
            book = parse_book(text, Path(filename).stem, rule.rules)
            duplicates = _find_duplicate_books(base, book.title, book.author, None)
            previews.append(
                {
                    "filename": filename,
                    "format": "TXT",
                    "title": book.title,
                    "author": book.author,
                    "volumes": len(book.volumes),
                    "chapters": len(book.root_chapters) + sum(len(v.chapters) for v in book.volumes),
                    "toc": _toc_preview(book, 10),
                    "output": f"{_safe_filename(book.title)}.epub",
                    "path": str(base / "<自动ID>"),
                    "duplicates": duplicates,
                    "upload_token": upload_token,
                }
            )
            continue

        previews.append(
            {
                "filename": filename,
                "format": "未知",
                "title": None,
                "author": None,
                "volumes": 0,
                "chapters": 0,
                "toc": [],
                "output": "—",
                "path": str(base / "<自动ID>"),
                "error": "不支持的文件类型（仅支持 .txt / .epub）",
                "duplicates": [],
                "upload_token": upload_token,
            }
        )

    return templates.TemplateResponse(
        "partials/upload_preview.html",
        {"request": request, "previews": previews},
    )


@app.post("/ingest", response_class=HTMLResponse)
async def ingest(
    request: Request,
    files: Optional[list[UploadFile]] = File(None),
    title: str = Form(""),
    author: str = Form(""),
    language: str = Form(""),
    description: str = Form(""),
    series: str = Form(""),
    identifier: str = Form(""),
    publisher: str = Form(""),
    tags: str = Form(""),
    published: str = Form(""),
    isbn: str = Form(""),
    rating: str = Form(""),
    rule_template: str = Form("default"),
    theme_template: str = Form(""),
    custom_css: str = Form(""),
    dedupe_mode: str = Form("keep"),
    cover_file: Optional[UploadFile] = File(None),
    upload_tokens: Optional[list[str]] = Form(None),
) -> HTMLResponse:
    file_list = files or []
    if isinstance(upload_tokens, list):
        raw_upload_tokens: Optional[list[str]] = upload_tokens
    elif isinstance(upload_tokens, str):
        raw_upload_tokens = [upload_tokens]
    else:
        raw_upload_tokens = None
    token_list = _normalize_upload_tokens(raw_upload_tokens)
    if not file_list and not token_list:
        raise HTTPException(status_code=400, detail="Empty file")

    cover_bytes = await cover_file.read() if cover_file else None
    cover_name = cover_file.filename if cover_file else None
    css_error = validate_css(custom_css)
    if css_error:
        rules = load_rule_templates()
        themes = load_theme_templates()
        return templates.TemplateResponse(
            "ingest.html",
            {
                "request": request,
                "rules": rules,
                "themes": themes,
                "error": f"自定义 CSS 校验失败：{css_error}",
                "custom_css": custom_css,
            },
        )

    base = library_dir()
    _cleanup_staged_uploads_except(base, token_list)
    staged_entries: list[dict] = []
    if token_list:
        for token in token_list:
            staged = _load_staged_upload(base, token)
            if staged:
                staged_entries.append(staged)
        if not staged_entries:
            rules = load_rule_templates()
            themes = load_theme_templates()
            return templates.TemplateResponse(
                "ingest.html",
                {
                    "request": request,
                    "rules": rules,
                    "themes": themes,
                    "error": "上传暂存已失效，请重新选择文件后再提交。",
                    "custom_css": custom_css,
                },
            )

    dedupe_mode = "normalize" if dedupe_mode == "normalize" else "keep"
    _ensure_ingest_worker_started()
    for entry in staged_entries:
        token = str(entry.get("token") or "").strip().lower()
        filename = str(entry.get("filename") or "upload")
        content_type_value = entry.get("content_type")
        content_type = content_type_value if isinstance(content_type_value, str) else None
        kind = str(entry.get("kind") or "").strip()
        size_value = entry.get("size")
        size = int(size_value) if isinstance(size_value, int) else 0
        if size <= 0:
            job = _create_job("ingest", None, rule_template)
            _update_job(job.id, status="failed", stage="失败", message=f"{filename}: 空文件", log=None)
            _cleanup_staged_upload(base, token)
            continue
        action, book_id, job_rule_template = _queued_job_spec(kind, rule_template)
        job = _create_job(action, book_id, job_rule_template)
        _update_job(job.id, stage="排队中", message="等待后台处理")
        payload_path = _move_staged_payload_to_queue(base, token, job.id, filename)
        if not payload_path or not payload_path.exists():
            _update_job(job.id, status="failed", stage="失败", message=f"{filename}: 暂存文件缺失", log=None)
            _cleanup_staged_upload(base, token)
            continue
        _ingest_queue.put(
            {
                "job_id": job.id,
                "payload_path": str(payload_path),
                "filename": filename,
                "content_type": content_type,
                "kind": kind,
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
                "rule_template": rule_template,
                "theme_template": theme_template,
                "custom_css": custom_css,
                "dedupe_mode": dedupe_mode,
                "cover_bytes": cover_bytes,
                "cover_name": cover_name,
            }
        )
        _cleanup_staged_upload(base, token)

    for upload_file in file_list:
        filename = upload_file.filename or "upload"
        probe = await upload_file.read(4096)
        await upload_file.seek(0)
        kind = _detect_source_type_probe(filename, upload_file.content_type, probe)
        action, book_id, job_rule_template = _queued_job_spec(kind, rule_template)
        job = _create_job(action, book_id, job_rule_template)
        _update_job(job.id, stage="排队中", message="等待后台处理")
        payload_path, size, _ = await _persist_queued_upload_stream(base, job.id, upload_file)
        if size <= 0:
            _update_job(job.id, status="failed", stage="失败", message=f"{filename}: 空文件", log=None)
            _cleanup_queued_upload(payload_path)
            continue
        _ingest_queue.put(
            {
                "job_id": job.id,
                "payload_path": str(payload_path),
                "filename": filename,
                "content_type": upload_file.content_type,
                "kind": kind,
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
                "rule_template": rule_template,
                "theme_template": theme_template,
                "custom_css": custom_css,
                "dedupe_mode": dedupe_mode,
                "cover_bytes": cover_bytes,
                "cover_name": cover_name,
            }
        )

    redirect_url = "/jobs"
    if _is_htmx(request):
        return _htmx_redirect(redirect_url)
    return RedirectResponse(url=redirect_url, status_code=303)


@app.get("/library", response_class=HTMLResponse)
async def library_partial(
    request: Request,
    sort: str = "updated",
    q: str = "",
    page: int = 1,
    read_filter: str = "all",
) -> HTMLResponse:
    base = library_dir()
    selected_sort = _normalize_sort(sort)
    payload = _library_page_data(base, selected_sort, q, page, read_filter)
    return_to = _library_return_to_url(selected_sort, q, payload["page"], payload["read_filter"])
    return templates.TemplateResponse(
        "partials/library_section.html",
        {"request": request, "sort": selected_sort, "q": q, "return_to": return_to, **payload},
    )


@app.get("/archive", response_class=HTMLResponse)
async def archive_view(request: Request) -> HTMLResponse:
    base = library_dir()
    books = [_book_view(book, archive_book_dir(base, book.book_id).parent) for book in list_archived_books(base)]
    return templates.TemplateResponse(
        "archive.html",
        {"request": request, "books": books},
    )


@app.get("/book/{book_id}", response_class=HTMLResponse)
async def book_detail(request: Request, book_id: str) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    return_to = _safe_internal_redirect_target(request.query_params.get("return_to", ""), "/")
    return_to_query = f"?return_to={urllib.parse.quote(return_to, safe='')}" if return_to != "/" else ""
    meta = load_metadata(base, book_id)
    book = load_book(base, book_id)
    sections = _book_sections(book)
    rules = load_rule_templates()
    themes = load_theme_templates()
    return templates.TemplateResponse(
        "book.html",
        {
            "request": request,
            "book": _book_view(meta, base),
            "sections": sections,
            "book_id": book_id,
            "rules": rules,
            "themes": themes,
            "return_to": return_to,
            "return_to_query": return_to_query,
        },
    )


@app.get("/book/{book_id}/download")
async def download(book_id: str) -> FileResponse:
    base = library_dir()
    _require_book(base, book_id)
    meta = load_metadata(base, book_id)
    _ensure_book_epub_css(base, meta)
    epub_file = epub_path(base, book_id)
    if not epub_file.exists():
        raise HTTPException(status_code=404, detail="EPUB missing")

    title = (meta.title or "").strip()
    safe_title = _safe_filename(title) if title else "book"
    author = (meta.author or "").strip()
    if not author:
        author = "未知"
    safe_author = _safe_filename(author)
    download_name = f"{safe_title}-{safe_author}.epub"
    return FileResponse(path=epub_file, filename=download_name, media_type="application/epub+zip")


@app.post("/books/download")
async def download_bulk(book_ids: list[str] = Form([])) -> Response:
    base = library_dir()
    selected_ids = _normalize_book_ids(book_ids)
    if not selected_ids:
        raise HTTPException(status_code=400, detail="未选择书籍")

    bundle_items: list[tuple[Metadata, Path]] = []
    for book_id in selected_ids:
        if not ensure_book_exists(base, book_id):
            continue
        meta = load_metadata(base, book_id)
        _ensure_book_epub_css(base, meta)
        item_path = epub_path(base, book_id)
        if item_path.exists():
            bundle_items.append((meta, item_path))

    if not bundle_items:
        raise HTTPException(status_code=404, detail="未找到可下载的 EPUB")

    archive_buffer = BytesIO()
    used_names: set[str] = set()
    with zipfile.ZipFile(archive_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for meta, item_path in bundle_items:
            title = (meta.title or "").strip()
            safe_title = _safe_filename(title) if title else "book"
            author = (meta.author or "").strip() or "未知"
            safe_author = _safe_filename(author)
            basename = f"{safe_title}-{safe_author}"
            archive_name = f"{basename}.epub"
            if archive_name in used_names:
                suffix = 2
                while True:
                    archive_name = f"{basename}-{suffix}.epub"
                    if archive_name not in used_names:
                        break
                    suffix += 1
            used_names.add(archive_name)
            archive.write(item_path, arcname=archive_name)

    bundle_name = f"bindery-books-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
    return Response(
        content=archive_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{bundle_name}"'},
    )


@app.get("/book/{book_id}/cover")
async def cover(book_id: str) -> FileResponse:
    base = library_dir()
    _require_book(base, book_id)
    meta = load_metadata(base, book_id)
    if not meta.cover_file:
        raise HTTPException(status_code=404, detail="Cover missing")
    path = cover_path(base, book_id, meta.cover_file)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Cover missing")
    return FileResponse(path, headers=_edge_bypass_browser_revalidate_headers())


@app.post("/book/{book_id}/cover/upload")
async def upload_cover(request: Request, book_id: str, cover: UploadFile = File(...)) -> RedirectResponse:
    base = library_dir()
    _require_book(base, book_id)
    data = await cover.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty cover")
    meta = load_metadata(base, book_id)
    meta.cover_file = save_cover_bytes(base, book_id, data, cover.filename)
    meta.updated_at = _now_iso()
    save_metadata(meta, base)

    cover_path_obj = cover_path(base, book_id, meta.cover_file)
    if meta.source_type == "epub":
        update_epub_metadata(
            epub_path(base, book_id),
            meta,
            cover_path_obj,
            css_text=_compose_css_text(meta),
            strip_webp_assets=True,
        )
    else:
        book = load_book(base, book_id)
        build_epub(book, meta, epub_path(base, book_id), cover_path_obj, css_text=_compose_css_text(meta))
    _update_meta_synced(meta)
    save_metadata(meta, base)

    if _is_htmx(request):
        return RedirectResponse(url=f"/book/{book_id}", status_code=303)
    return RedirectResponse(url=f"/book/{book_id}", status_code=303)


@app.post("/book/{book_id}/cover/url")
async def upload_cover_url(
    request: Request,
    book_id: str,
    cover_url: str = Form(""),
) -> RedirectResponse:
    base = library_dir()
    _require_book(base, book_id)
    if not cover_url:
        raise HTTPException(status_code=400, detail="Missing URL")
    try:
        data, filename = _download_cover_from_url(cover_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    meta = load_metadata(base, book_id)
    meta.cover_file = save_cover_bytes(base, book_id, data, filename)
    meta.updated_at = _now_iso()
    save_metadata(meta, base)

    cover_path_obj = cover_path(base, book_id, meta.cover_file)
    if meta.source_type == "epub":
        update_epub_metadata(
            epub_path(base, book_id),
            meta,
            cover_path_obj,
            css_text=_compose_css_text(meta),
            strip_webp_assets=True,
        )
    else:
        book = load_book(base, book_id)
        build_epub(book, meta, epub_path(base, book_id), cover_path_obj, css_text=_compose_css_text(meta))
    _update_meta_synced(meta)
    save_metadata(meta, base)
    return RedirectResponse(url=f"/book/{book_id}", status_code=303)


@app.post("/book/{book_id}/cover/extract")
async def extract_cover_view(book_id: str) -> RedirectResponse:
    base = library_dir()
    _require_book(base, book_id)
    epub_file = epub_path(base, book_id)
    extracted = extract_cover(epub_file)
    if not extracted:
        raise HTTPException(status_code=404, detail="No cover in EPUB")
    data, name = extracted
    meta = load_metadata(base, book_id)
    meta.cover_file = save_cover_bytes(base, book_id, data, name)
    meta.updated_at = _now_iso()
    save_metadata(meta, base)

    cover_path_obj = cover_path(base, book_id, meta.cover_file)
    if meta.source_type == "epub":
        update_epub_metadata(
            epub_path(base, book_id),
            meta,
            cover_path_obj,
            css_text=_compose_css_text(meta),
            strip_webp_assets=True,
        )
    else:
        book = load_book(base, book_id)
        build_epub(book, meta, epub_path(base, book_id), cover_path_obj, css_text=_compose_css_text(meta))
    _update_meta_synced(meta)
    save_metadata(meta, base)
    return RedirectResponse(url=f"/book/{book_id}", status_code=303)


@app.get("/book/{book_id}/preview")
async def preview_first(request: Request, book_id: str) -> RedirectResponse:
    base = library_dir()
    _require_book(base, book_id)
    epub_file = epub_path(base, book_id)
    if not epub_file.exists():
        raise HTTPException(status_code=404, detail="EPUB missing")
    sections = list_epub_sections(epub_file)
    if not sections:
        raise HTTPException(status_code=404, detail="No sections")
    return_to = _safe_internal_redirect_target(request.query_params.get("return_to", ""), "")
    target = f"/book/{book_id}/preview/0"
    query_params: dict[str, str] = {"resume": "1"}
    if return_to:
        query_params["return_to"] = return_to
    target += f"?{urllib.parse.urlencode(query_params)}"
    response = RedirectResponse(url=target, status_code=303)
    response.headers.update(_no_store_headers())
    return response


@app.post("/book/{book_id}/progress")
async def save_reader_progress(request: Request, book_id: str) -> dict[str, object]:
    base = library_dir()
    _require_book(base, book_id)
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    section = _clamp_int(payload.get("section"), -1, 999_999, 0)
    page = _clamp_int(payload.get("page"), 0, 999_999, 0)
    page_count = _clamp_int(payload.get("page_count"), 0, 999_999, 0)
    upsert_reader_progress(book_id, section, page, page_count, _now_iso())
    return {"ok": True, "book_id": book_id, "section": section, "page": page, "page_count": page_count}


@app.get("/book/{book_id}/preview/{section_index}", response_class=HTMLResponse)
async def preview(request: Request, book_id: str, section_index: int) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    return_to = _safe_internal_redirect_target(request.query_params.get("return_to", ""), "/")
    return_to_query = f"?return_to={urllib.parse.quote(return_to, safe='')}" if return_to != "/" else ""
    meta = load_metadata(base, book_id)
    _ensure_book_epub_css(base, meta)
    progress = get_reader_progress(book_id)
    epub_file = epub_path(base, book_id)
    if not epub_file.exists():
        raise HTTPException(status_code=404, detail="EPUB missing")
    sections = list_epub_sections(epub_file)

    if section_index < 0 or section_index >= len(sections):
        raise HTTPException(status_code=404, detail="Section not found")

    current = sections[section_index]
    prev_idx = section_index - 1 if section_index > 0 else None
    next_idx = section_index + 1 if section_index < len(sections) - 1 else None
    sections_payload = [
        {
            "index": idx,
            "title": sec.title,
            "content_url": f"/book/{book_id}/epub/{sec.item_path}",
        }
        for idx, sec in enumerate(sections)
    ]

    return templates.TemplateResponse(
        "preview.html",
        {
            "request": request,
            "book": _book_view(meta, base),
            "toc": [{"index": idx, "title": sec.title} for idx, sec in enumerate(sections)],
            "sections_payload": sections_payload,
            "section": {
                "title": current.title,
                "content_url": f"/book/{book_id}/epub/{current.item_path}",
            },
            "section_index": section_index,
            "prev_idx": prev_idx,
            "next_idx": next_idx,
            "return_to": return_to,
            "return_to_query": return_to_query,
            "initial_progress": progress,
            "hide_nav": True,
            "main_class": "h-screen w-screen p-0",
        },
        headers=_no_store_headers(),
    )


@app.get("/book/{book_id}/epub/{item_path:path}")
async def epub_item(book_id: str, item_path: str) -> Response:
    base = library_dir()
    _require_book(base, book_id)
    epub_file = epub_path(base, book_id)
    if not epub_file.exists():
        raise HTTPException(status_code=404, detail="EPUB missing")
    item_path = urllib.parse.unquote(item_path)
    try:
        base_href = epub_base_href(f"/book/{book_id}/epub/", item_path)
        content, media_type = load_epub_item(epub_file, item_path, base_href)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Item not found")
    return Response(content=content, media_type=media_type, headers=_edge_bypass_browser_revalidate_headers())


@app.get("/book/{book_id}/search")
async def search_book(
    book_id: str,
    q: str = Query(default="", min_length=0, max_length=200),
    limit: int = Query(default=10, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> dict[str, object]:
    base = library_dir()
    _require_book(base, book_id)
    query = _normalize_search_text(q)
    if not query:
        return {"query": "", "hits": [], "indexed_sections": 0}

    epub_file = epub_path(base, book_id)
    if not epub_file.exists():
        raise HTTPException(status_code=404, detail="EPUB missing")

    hits, indexed_sections, has_more, next_offset = _search_epub_hits(
        epub_file,
        query,
        limit,
        offset=offset,
    )
    return {
        "query": query,
        "hits": hits,
        "indexed_sections": indexed_sections,
        "offset": offset,
        "limit": limit,
        "next_offset": next_offset,
        "has_more": has_more,
    }


@app.get("/book/{book_id}/edit", response_class=HTMLResponse)
async def edit_metadata(request: Request, book_id: str) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    return_to = _safe_internal_redirect_target(request.query_params.get("return_to", ""), "/")
    return_to_query = f"?return_to={urllib.parse.quote(return_to, safe='')}" if return_to != "/" else ""
    meta = load_metadata(base, book_id)
    rules = load_rule_templates()
    themes = load_theme_templates()
    template = "partials/meta_edit.html" if _is_htmx(request) else "edit.html"
    return templates.TemplateResponse(
        template,
        {
            "request": request,
            "book": _book_view(meta, base),
            "book_id": book_id,
            "rules": rules,
            "themes": themes,
            "strip_original_css": False,
            "return_to": return_to,
            "return_to_query": return_to_query,
        },
    )


@app.post("/book/{book_id}/metadata/fetch", response_class=HTMLResponse)
async def fetch_metadata(
    request: Request,
    book_id: str,
    title: str = Form(""),
    author: str = Form(""),
    language: str = Form(""),
    description: str = Form(""),
    series: str = Form(""),
    publisher: str = Form(""),
    tags: str = Form(""),
    published: str = Form(""),
    isbn: str = Form(""),
    rating: str = Form(""),
    rule_template: str = Form(""),
    theme_template: str = Form(""),
    custom_css: str = Form(""),
    strip_original_css: str = Form(""),
    cover_url: str = Form(""),
    metadata_source: str = Form(""),
    return_to: str = Form(""),
) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    safe_return_to = _safe_internal_redirect_target(return_to, "/")
    return_to_query = f"?return_to={urllib.parse.quote(safe_return_to, safe='')}" if safe_return_to != "/" else ""
    meta = load_metadata(base, book_id)
    book = load_book(base, book_id)

    rules = load_rule_templates()
    themes = load_theme_templates()
    template = "partials/meta_edit.html" if _is_htmx(request) else "edit.html"
    strip_original_css_enabled = _is_true_flag(strip_original_css)

    draft_book = _build_edit_draft_view(
        meta,
        base,
        book,
        title=title,
        author=author,
        language=language,
        description=description,
        series=series,
        publisher=publisher,
        tags=tags,
        published=published,
        isbn=isbn,
        rating=rating,
        rule_template=rule_template,
        theme_template=theme_template,
        custom_css=custom_css,
        cover_url=cover_url,
    )

    query = str(draft_book.get("title") or "").strip()
    candidates, best_source, lookup_errors, lookup_attempts = lookup_book_metadata_candidates(query)
    if not candidates:
        detail = "；".join(lookup_errors[:2]) if lookup_errors else "未返回可用结果"
        logger.warning(
            "metadata lookup failed book_id=%s query=%r detail=%s attempts=%r",
            book_id,
            query,
            detail,
            lookup_attempts,
        )
        print(
            f"[bindery] metadata lookup failed book_id={book_id} query={query!r} "
            f"detail={detail} attempts={lookup_attempts!r}"
        )
        return templates.TemplateResponse(
            template,
            {
                "request": request,
                "book": draft_book,
                "book_id": book_id,
                "rules": rules,
                "themes": themes,
                "error": f"未能从 Amazon/豆瓣获取元数据：{detail}",
                "lookup_attempts": lookup_attempts,
                "lookup_sources": [],
                "lookup_selected_source": "",
                "lookup_changed_fields": [],
                "lookup_candidates": {},
                "lookup_allow_cover_fill": False,
                "strip_original_css": strip_original_css_enabled,
                "return_to": safe_return_to,
                "return_to_query": return_to_query,
            },
        )

    selected_source = metadata_source.strip().lower()
    if selected_source not in candidates:
        selected_source = best_source or ""
    result = candidates.get(selected_source)
    if not result:
        detail = "；".join(lookup_errors[:2]) if lookup_errors else "未返回可用结果"
        return templates.TemplateResponse(
            template,
            {
                "request": request,
                "book": draft_book,
                "book_id": book_id,
                "rules": rules,
                "themes": themes,
                "error": f"未能从 Amazon/豆瓣获取元数据：{detail}",
                "lookup_attempts": lookup_attempts,
                "lookup_sources": [],
                "lookup_selected_source": "",
                "lookup_changed_fields": [],
                "lookup_candidates": {},
                "lookup_allow_cover_fill": False,
                "strip_original_css": strip_original_css_enabled,
                "return_to": safe_return_to,
                "return_to_query": return_to_query,
            },
        )

    has_existing_cover = bool(meta.cover_file or draft_book.get("cover_url"))
    has_manual_cover_fetch_url = bool(str(draft_book.get("cover_fetch_url") or "").strip())
    allow_cover_fill = (not has_existing_cover) and (not has_manual_cover_fetch_url)
    changed_fields = _apply_lookup_metadata_to_draft(
        draft_book,
        result,
        allow_cover_fill=allow_cover_fill,
    )

    source_name = _lookup_source_label(result.source)
    if len(candidates) > 1:
        info = f"已自动使用 {source_name} 填充字段，可切换来源后再次应用。"
    else:
        info = f"已从 {source_name} 自动填充字段，请检查后再保存并写回。"
    if "cover_url" in changed_fields:
        info += "（已回填豆瓣封面 URL）"
    if lookup_errors:
        info += "（另一个来源返回失败）"
    lookup_result = _lookup_result_view(
        query,
        source_name,
        draft_book,
        lookup_errors,
        source_cover_url=result.cover_url,
    )
    logger.info(
        "metadata lookup success book_id=%s query=%r source=%s title=%r author=%r language=%r publisher=%r published=%r isbn=%r source_cover_url=%r applied_cover_url=%r tags=%r errors=%r attempts=%r",
        book_id,
        lookup_result["query"],
        result.source,
        lookup_result["title"],
        lookup_result["author"],
        lookup_result["language"],
        lookup_result["publisher"],
        lookup_result["published"],
        lookup_result["isbn"],
        lookup_result["cover_url"],
        lookup_result["applied_cover_url"],
        lookup_result["tags"],
        lookup_result["errors"],
        lookup_attempts,
    )
    print(
        f"[bindery] metadata lookup success book_id={book_id} query={lookup_result['query']!r} "
        f"source={result.source} title={lookup_result['title']!r} author={lookup_result['author']!r} "
        f"publisher={lookup_result['publisher']!r} published={lookup_result['published']!r} "
        f"isbn={lookup_result['isbn']!r} source_cover_url={lookup_result['cover_url']!r} "
        f"applied_cover_url={lookup_result['applied_cover_url']!r} "
        f"tags={lookup_result['tags']!r} "
        f"errors={lookup_result['errors']!r} attempts={lookup_attempts!r}"
    )

    return templates.TemplateResponse(
        template,
        {
            "request": request,
            "book": draft_book,
            "book_id": book_id,
            "rules": rules,
            "themes": themes,
            "info": info,
            "lookup_result": lookup_result,
            "lookup_attempts": lookup_attempts,
            "lookup_sources": _lookup_sources_view(candidates, result.source),
            "lookup_selected_source": result.source,
            "lookup_changed_fields": changed_fields,
            "lookup_candidates": _lookup_candidates_payload(candidates),
            "lookup_allow_cover_fill": allow_cover_fill,
            "strip_original_css": strip_original_css_enabled,
            "return_to": safe_return_to,
            "return_to_query": return_to_query,
        },
    )


@app.post("/book/{book_id}/edit", response_class=HTMLResponse)
async def save_edit(
    request: Request,
    book_id: str,
    title: str = Form(""),
    author: str = Form(""),
    language: str = Form(""),
    description: str = Form(""),
    series: str = Form(""),
    identifier: Optional[str] = Form(None),
    publisher: str = Form(""),
    tags: str = Form(""),
    published: str = Form(""),
    isbn: str = Form(""),
    rating: str = Form(""),
    rule_template: str = Form(""),
    theme_template: str = Form(""),
    custom_css: str = Form(""),
    strip_original_css: str = Form(""),
    cover_file: Optional[UploadFile] = File(None),
    cover_url: str = Form(""),
    return_to: str = Form(""),
) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    safe_return_to = _safe_internal_redirect_target(return_to, "/")
    return_to_query = f"?return_to={urllib.parse.quote(safe_return_to, safe='')}" if safe_return_to != "/" else ""
    meta = load_metadata(base, book_id)
    book = load_book(base, book_id)
    strip_original_css_enabled = _is_true_flag(strip_original_css)

    meta.title = title.strip() or book.title or "未命名"
    meta.author = author.strip() or None
    meta.language = language.strip() or "zh-CN"
    meta.description = description.strip() or None
    meta.series = series.strip() or None
    if identifier is not None:
        meta.identifier = identifier.strip() or None
    meta.publisher = publisher.strip() or None
    meta.tags = _parse_tags(tags)
    meta.published = published.strip() or None
    meta.isbn = isbn.strip() or None
    meta.rating = _parse_rating(rating)
    css_error = validate_css(custom_css)
    if css_error:
        meta.custom_css = custom_css.strip() or None
        rules = load_rule_templates()
        themes = load_theme_templates()
        template = "partials/meta_edit.html" if _is_htmx(request) else "edit.html"
        return templates.TemplateResponse(
            template,
            {
                "request": request,
                "book": _book_view(meta, base),
                "book_id": book_id,
                "rules": rules,
                "themes": themes,
                "error": f"自定义 CSS 校验失败：{css_error}",
                "strip_original_css": strip_original_css_enabled,
                "return_to": safe_return_to,
                "return_to_query": return_to_query,
            },
        )
    if meta.source_type != "epub":
        meta.rule_template = rule_template.strip() or meta.rule_template or "default"
    raw_theme = theme_template.strip()
    if meta.source_type == "epub" and raw_theme == KEEP_BOOK_THEME_ID:
        meta.theme_template = KEEP_BOOK_THEME_ID
    else:
        meta.theme_template = raw_theme or DEFAULT_THEME_ID
        if meta.theme_template == KEEP_BOOK_THEME_ID:
            meta.theme_template = DEFAULT_THEME_ID
    meta.custom_css = custom_css.strip() or None
    meta.status = "dirty"
    meta.updated_at = _now_iso()

    cover_bytes: Optional[bytes] = None
    cover_name: Optional[str] = None
    cover_url = cover_url.strip()
    cover_error: Optional[str] = None
    if cover_file is not None:
        data = await cover_file.read()
        if not data:
            cover_error = "封面文件为空"
        else:
            cover_bytes = data
            cover_name = cover_file.filename or "cover"

    if cover_error:
        rules = load_rule_templates()
        themes = load_theme_templates()
        template = "partials/meta_edit.html" if _is_htmx(request) else "edit.html"
        return templates.TemplateResponse(
            template,
            {
                "request": request,
                "book": _book_view(meta, base),
                "book_id": book_id,
                "rules": rules,
                "themes": themes,
                "error": cover_error,
                "strip_original_css": strip_original_css_enabled,
                "return_to": safe_return_to,
                "return_to_query": return_to_query,
            },
        )

    save_metadata(meta, base)
    job = _create_job("edit-writeback", book_id, meta.rule_template)
    _update_job(job.id, stage="排队中", message="等待后台处理")
    _ensure_ingest_worker_started()
    _ingest_queue.put(
        {
            "job_id": job.id,
            "kind": "edit-writeback",
            "book_id": book_id,
            "cover_bytes": cover_bytes,
            "cover_name": cover_name,
            "cover_url": cover_url,
            "strip_original_css": strip_original_css_enabled,
        }
    )

    redirect_url = "/jobs?tab=running"
    if _is_htmx(request):
        return _htmx_redirect(redirect_url)
    return RedirectResponse(url=redirect_url, status_code=303)


@app.post("/book/{book_id}/regenerate")
async def regenerate(
    book_id: str,
    rule_template: str = Form("default"),
    next: str = Form(""),
) -> RedirectResponse:
    base = library_dir()
    _require_book(base, book_id)
    meta = load_metadata(base, book_id)
    if meta.source_type == "epub":
        raise HTTPException(status_code=400, detail="EPUB 导入的书籍无法重新生成")
    job = _create_job("regenerate", book_id, rule_template)
    _run_regenerate(job, base, book_id, rule_template)
    target = _safe_internal_redirect_target(next, f"/book/{book_id}")
    return RedirectResponse(url=target, status_code=303)


@app.post("/book/{book_id}/archive")
async def archive_view(book_id: str, next: str = Form("")) -> RedirectResponse:
    base = library_dir()
    _require_book(base, book_id)
    meta = load_metadata(base, book_id)
    meta.archived = True
    meta.updated_at = _now_iso()
    save_metadata(meta, base)
    archive_book(base, book_id)
    target = _safe_internal_redirect_target(next, "/")
    return RedirectResponse(url=target, status_code=303)


@app.post("/book/{book_id}/read")
async def set_read_status(
    request: Request,
    book_id: str,
    read: str = Form(""),
    next: str = Form(""),
) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    meta = load_metadata(base, book_id)
    normalized = read.strip().lower()
    meta.read = normalized in {"1", "true", "yes", "on"}
    meta.read_updated_at = _now_iso()
    save_metadata(meta, base)
    target = _safe_internal_redirect_target(next, f"/book/{book_id}")
    parsed_target = urllib.parse.urlparse(target)
    target_query = urllib.parse.parse_qs(parsed_target.query)
    target_return_to = _safe_internal_redirect_target(target_query.get("return_to", [""])[0], "/")
    target_return_to_query = (
        f"?return_to={urllib.parse.quote(target_return_to, safe='')}" if target_return_to != "/" else ""
    )

    if _is_htmx(request):
        return templates.TemplateResponse(
            "partials/meta_view.html",
            {
                "request": request,
                "book": _book_view(meta, base),
                "book_id": book_id,
                "return_to": target_return_to,
                "return_to_query": target_return_to_query,
            },
        )

    return RedirectResponse(url=target, status_code=303)


@app.post("/books/archive")
async def archive_bulk(book_ids: list[str] = Form([])) -> RedirectResponse:
    base = library_dir()
    for book_id in _normalize_book_ids(book_ids):
        if not ensure_book_exists(base, book_id):
            continue
        meta = load_metadata(base, book_id)
        if meta.archived:
            continue
        meta.archived = True
        meta.updated_at = _now_iso()
        save_metadata(meta, base)
        archive_book(base, book_id)
    return RedirectResponse(url="/", status_code=303)


@app.post("/book/{book_id}/restore")
async def restore_view(book_id: str) -> RedirectResponse:
    base = library_dir()
    src = archive_book_dir(base, book_id)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Book not found")
    dest = base / book_id
    if dest.exists():
        raise HTTPException(status_code=409, detail="Book exists")
    src.replace(dest)
    meta = load_metadata(base, book_id)
    meta.archived = False
    meta.updated_at = _now_iso()
    save_metadata(meta, base)
    return RedirectResponse(url="/", status_code=303)


@app.post("/archive/delete-bulk")
async def archive_delete_bulk(book_ids: list[str] = Form([])) -> RedirectResponse:
    base = library_dir()
    for book_id in _normalize_book_ids(book_ids):
        if not archive_book_dir(base, book_id).exists():
            continue
        delete_book_data(base, book_id)
    return RedirectResponse(url="/archive", status_code=303)


@app.post("/book/{book_id}/delete")
async def delete_book(request: Request, book_id: str, next: str = Form("")) -> HTMLResponse:
    base = library_dir()
    if not BOOK_ID_RE.match(book_id):
        raise HTTPException(status_code=404, detail="Invalid book id")
    delete_book_data(base, book_id)
    if _is_htmx(request):
        return HTMLResponse("")
    target = _safe_internal_redirect_target(next, "/")
    return RedirectResponse(url=target, status_code=303)


@app.get("/jobs", response_class=HTMLResponse)
async def jobs_view(request: Request, tab: str = "running", page: int = 1) -> HTMLResponse:
    selected_tab = tab if tab in {"running", "success", "failed"} else "running"
    selected_page = max(1, page)
    base = library_dir()
    meta_index = {meta.book_id: meta for meta in _all_book_meta(base)}
    all_jobs = list_jobs()
    grouped = {
        "running": [_job_view(job, meta_index) for job in all_jobs if job.status == "running"],
        "success": [_job_view(job, meta_index) for job in all_jobs if job.status == "success"],
        "failed": [_job_view(job, meta_index) for job in all_jobs if job.status == "failed"],
    }
    tabs = [
        {"key": "running", "label": "进行中", "count": len(grouped["running"])},
        {"key": "success", "label": "已完成", "count": len(grouped["success"])},
        {"key": "failed", "label": "失败", "count": len(grouped["failed"])},
    ]
    page_size = 12
    selected_jobs = grouped[selected_tab]
    total_jobs = len(selected_jobs)
    total_pages = max(1, (total_jobs + page_size - 1) // page_size)
    if selected_page > total_pages:
        selected_page = total_pages
    start = (selected_page - 1) * page_size
    page_jobs = selected_jobs[start : start + page_size]
    invalid_job_count = len(_invalid_job_ids(all_jobs, meta_index))
    return templates.TemplateResponse(
        "jobs.html",
        {
            "request": request,
            "jobs": page_jobs,
            "tabs": tabs,
            "active_tab": selected_tab,
            "page": selected_page,
            "total_pages": total_pages,
            "total_jobs": total_jobs,
            "invalid_job_count": invalid_job_count,
        },
    )


@app.post("/jobs/{job_id}/retry")
async def retry_job(job_id: str, rule_template: str = Form("default")) -> RedirectResponse:
    job = get_job(job_id)
    if not job or not job.book_id:
        raise HTTPException(status_code=404, detail="Job not found")
    base = library_dir()
    meta = load_metadata(base, job.book_id)
    if meta.source_type == "epub":
        raise HTTPException(status_code=400, detail="EPUB 导入的书籍无法重试生成")
    new_job = _create_job("retry", job.book_id, rule_template)
    _run_regenerate(new_job, base, job.book_id, rule_template)
    return RedirectResponse(url=f"/jobs", status_code=303)


@app.post("/jobs/cleanup-invalid")
async def cleanup_invalid_jobs(tab: str = Form("running")) -> RedirectResponse:
    selected_tab = tab if tab in {"running", "success", "failed"} else "running"
    base = library_dir()
    meta_index = {meta.book_id: meta for meta in _all_book_meta(base)}
    stale_ids = _invalid_job_ids(list_jobs(), meta_index)
    if stale_ids:
        delete_jobs(stale_ids)
    return RedirectResponse(url=f"/jobs?tab={selected_tab}", status_code=303)


@app.get("/rules", response_class=HTMLResponse)
async def rules_view(request: Request) -> HTMLResponse:
    rules = load_rule_templates()
    themes = load_theme_templates()
    error = (request.query_params.get("error") or "").strip() or None
    tab = (request.query_params.get("tab") or "parsing").strip()
    if tab not in {"parsing", "themes"}:
        tab = "parsing"

    requested_rule = (request.query_params.get("rule_id") or "").strip()
    initial_rule = requested_rule if any(r.rule_id == requested_rule for r in rules) else (rules[0].rule_id if rules else "default")

    requested_theme = (request.query_params.get("theme_id") or "").strip()
    initial_theme = requested_theme if any(t.theme_id == requested_theme for t in themes) else (themes[0].theme_id if themes else "default")
    return templates.TemplateResponse(
        "rules.html",
        {
            "request": request,
            "rules": rules,
            "themes": themes,
            "error": error,
            "initial_tab": tab,
            "initial_rule": initial_rule,
            "initial_theme": initial_theme,
        },
    )


@app.get("/rules/{rule_id}/editor", response_class=HTMLResponse)
async def rule_editor(request: Request, rule_id: str) -> HTMLResponse:
    rule = _require_rule_template(rule_id)
    try:
        raw_json = rule.file_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to read rule file") from exc
    return templates.TemplateResponse(
        "partials/rule_editor.html",
        {"request": request, "rule": rule, "raw_json": raw_json, "saved": False, "error": None, "preview": None},
    )


@app.post("/rules/{rule_id}/editor", response_class=HTMLResponse)
async def rule_editor_save(request: Request, rule_id: str, config_json: str = Form("")) -> HTMLResponse:
    rule = _require_rule_template(rule_id)
    try:
        data = validate_rule_template_json(rule_id, config_json)
    except RuleTemplateError as exc:
        return templates.TemplateResponse(
            "partials/rule_editor.html",
            {
                "request": request,
                "rule": rule,
                "raw_json": config_json,
                "saved": False,
                "error": str(exc),
                "preview": None,
            },
        )
    rule.file_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    rule = _require_rule_template(rule_id)
    raw_json = rule.file_path.read_text(encoding="utf-8")
    return templates.TemplateResponse(
        "partials/rule_editor.html",
        {"request": request, "rule": rule, "raw_json": raw_json, "saved": True, "error": None, "preview": None},
    )


@app.post("/rules/new")
async def rule_new(request: Request) -> Response:
    base = rules_dir()
    suffix = uuid.uuid4().hex[:8]
    rule_id = f"custom-{suffix}"
    while (base / f"{rule_id}.json").exists():
        suffix = uuid.uuid4().hex[:8]
        rule_id = f"custom-{suffix}"

    seed = None
    default_file = base / "default.json"
    if default_file.exists():
        try:
            seed = json.loads(default_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            seed = None
    if isinstance(seed, dict):
        try:
            seed = validate_rule_template_json("default", json.dumps(seed, ensure_ascii=False))
        except RuleTemplateError:
            seed = None
    if not isinstance(seed, dict):
        seed = {
            "id": DEFAULT_RULE_CONFIG.rule_id,
            "name": DEFAULT_RULE_CONFIG.name,
            "description": "默认切章规则",
            "version": "1",
            "chapter_patterns": list(DEFAULT_RULE_CONFIG.chapter_patterns),
            "volume_patterns": list(DEFAULT_RULE_CONFIG.volume_patterns),
            "special_headings": list(DEFAULT_RULE_CONFIG.special_headings),
            "heading_max_len": DEFAULT_RULE_CONFIG.heading_max_len,
            "heading_max_commas": DEFAULT_RULE_CONFIG.heading_max_commas,
            "skip_candidate_re": DEFAULT_RULE_CONFIG.skip_candidate_re,
        }

    seed["id"] = rule_id
    seed["name"] = "新规则"
    seed["description"] = "自定义切章规则"
    seed["version"] = "1"
    (base / f"{rule_id}.json").write_text(json.dumps(seed, ensure_ascii=False, indent=2), encoding="utf-8")

    redirect_url = f"/rules?tab=parsing&rule_id={rule_id}"
    if _is_htmx(request):
        return _htmx_redirect(redirect_url)
    return RedirectResponse(url=redirect_url, status_code=303)


@app.post("/rules/{rule_id}/delete")
async def rule_delete(request: Request, rule_id: str) -> Response:
    if rule_id == "default":
        raise HTTPException(status_code=400, detail="默认模板不可删除")
    rule = _require_rule_template(rule_id)
    base = library_dir()
    if _rule_referenced(base, rule_id):
        msg = urllib.parse.quote("模板已被书籍引用，无法删除")
        redirect_url = f"/rules?tab=parsing&rule_id={rule_id}&error={msg}"
        if _is_htmx(request):
            return _htmx_redirect(redirect_url)
        return RedirectResponse(url=redirect_url, status_code=303)
    try:
        rule.file_path.unlink(missing_ok=False)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Rule file missing") from exc

    redirect_url = "/rules?tab=parsing&rule_id=default"
    if _is_htmx(request):
        return _htmx_redirect(redirect_url)
    return RedirectResponse(url=redirect_url, status_code=303)


@app.post("/themes/new")
async def theme_new(request: Request) -> Response:
    base = themes_dir()
    suffix = uuid.uuid4().hex[:8]
    theme_id = f"theme-{suffix}"
    while (base / f"{theme_id}.json").exists():
        suffix = uuid.uuid4().hex[:8]
        theme_id = f"theme-{suffix}"

    css = ""
    try:
        default_theme = get_theme(DEFAULT_THEME_ID)
        if default_theme.css.strip():
            css = default_theme.css
    except Exception:
        pass
    data = {
        "id": theme_id,
        "name": "新样式",
        "description": "自定义渲染主题",
        "version": "1",
        "css": css,
    }
    (base / f"{theme_id}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    redirect_url = f"/rules?tab=themes&theme_id={theme_id}"
    if _is_htmx(request):
        return _htmx_redirect(redirect_url)
    return RedirectResponse(url=redirect_url, status_code=303)


@app.post("/themes/{theme_id}/delete")
async def theme_delete(request: Request, theme_id: str) -> Response:
    if theme_id == DEFAULT_THEME_ID:
        raise HTTPException(status_code=400, detail="默认模板不可删除")
    theme = _require_theme(theme_id)
    base = library_dir()
    if _theme_referenced(base, theme_id):
        msg = urllib.parse.quote("模板已被书籍引用，无法删除")
        redirect_url = f"/rules?tab=themes&theme_id={theme_id}&error={msg}"
        if _is_htmx(request):
            return _htmx_redirect(redirect_url)
        return RedirectResponse(url=redirect_url, status_code=303)
    try:
        theme.file_path.unlink(missing_ok=False)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Theme file missing") from exc

    redirect_url = "/rules?tab=themes&theme_id=default"
    if _is_htmx(request):
        return _htmx_redirect(redirect_url)
    return RedirectResponse(url=redirect_url, status_code=303)


@app.get("/themes/{theme_id}/editor", response_class=HTMLResponse)
async def theme_editor(request: Request, theme_id: str) -> HTMLResponse:
    theme = _require_theme(theme_id)
    return templates.TemplateResponse(
        "partials/theme_editor.html",
        {"request": request, "theme": theme, "saved": False},
    )


@app.post("/themes/{theme_id}/editor", response_class=HTMLResponse)
async def theme_editor_save(request: Request, theme_id: str, css: str = Form("")) -> HTMLResponse:
    theme = _require_theme(theme_id)
    css_error = validate_css(css)
    if css_error:
        return templates.TemplateResponse(
            "partials/theme_editor.html",
            {
                "request": request,
                "theme": theme.__class__(
                    theme_id=theme.theme_id,
                    name=theme.name,
                    description=theme.description,
                    version=theme.version,
                    file_path=theme.file_path,
                    css=css,
                ),
                "saved": False,
                "error": f"主题 CSS 校验失败：{css_error}",
            },
        )
    try:
        data = json.loads(theme.file_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Theme file is not valid JSON") from exc
    data["css"] = css
    theme.file_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    theme = _require_theme(theme_id)
    return templates.TemplateResponse(
        "partials/theme_editor.html",
        {"request": request, "theme": theme, "saved": True},
    )


@app.post("/rules/test", response_class=HTMLResponse)
async def rules_test(
    request: Request,
    sample: str = Form(""),
    rule_template: str = Form("default"),
) -> HTMLResponse:
    if not sample.strip():
        return templates.TemplateResponse(
            "partials/rules_preview.html",
            {"request": request, "preview": None},
        )
    rule = get_rule(rule_template)
    book = parse_book(sample, "sample", rule.rules)
    preview = {
        "volumes": len(book.volumes),
        "chapters": len(book.root_chapters) + sum(len(v.chapters) for v in book.volumes),
        "toc": _toc_preview(book, 15),
    }
    return templates.TemplateResponse(
        "partials/rules_preview.html",
        {"request": request, "preview": preview},
    )
