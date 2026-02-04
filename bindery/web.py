from __future__ import annotations

import datetime as dt
import re
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .epub import build_epub
from .models import Book, Metadata, Volume
from .parsing import decode_text, parse_book
from .storage import (
    ensure_book_exists,
    epub_path,
    library_dir,
    load_book,
    load_metadata,
    list_books,
    new_book_id,
    save_book,
    save_metadata,
    write_source_text,
)

BASE_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"
BOOK_ID_RE = re.compile(r"^[a-f0-9]{32}$")

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _is_htmx(request: Request) -> bool:
    return request.headers.get("HX-Request") == "true"


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


def _require_book(base: Path, book_id: str) -> None:
    if not BOOK_ID_RE.match(book_id):
        raise HTTPException(status_code=404, detail="Invalid book id")
    if not ensure_book_exists(base, book_id):
        raise HTTPException(status_code=404, detail="Book not found")


def _build_metadata(
    book_id: str,
    book: Book,
    title: str,
    author: str,
    language: str,
    description: str,
    publisher: str,
    tags: str,
    published: str,
    isbn: str,
    rating: str,
) -> Metadata:
    meta_title = title.strip() if title.strip() else (book.title or "未命名")
    meta_author = author.strip() if author.strip() else (book.author or None)
    meta_language = language.strip() if language.strip() else "zh-CN"
    meta_description = description.strip() if description.strip() else (book.intro or None)
    meta_publisher = publisher.strip() if publisher.strip() else None
    meta_tags = _parse_tags(tags)
    meta_published = published.strip() if published.strip() else None
    meta_isbn = isbn.strip() if isbn.strip() else None
    meta_rating = _parse_rating(rating)

    now = _now_iso()
    return Metadata(
        book_id=book_id,
        title=meta_title,
        author=meta_author,
        language=meta_language,
        description=meta_description,
        publisher=meta_publisher,
        tags=meta_tags,
        published=meta_published,
        isbn=meta_isbn,
        rating=meta_rating,
        created_at=now,
        updated_at=now,
    )


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    base = library_dir()
    books = list_books(base)
    return templates.TemplateResponse("index.html", {"request": request, "books": books})


@app.post("/upload", response_class=HTMLResponse)
async def upload(
    request: Request,
    txt_file: UploadFile = File(...),
    title: str = Form(""),
    author: str = Form(""),
    language: str = Form(""),
    description: str = Form(""),
    publisher: str = Form(""),
    tags: str = Form(""),
    published: str = Form(""),
    isbn: str = Form(""),
    rating: str = Form(""),
) -> HTMLResponse:
    data = await txt_file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    text = decode_text(data)
    if not text.strip():
        raise HTTPException(status_code=400, detail="Empty content")

    source_name = Path(txt_file.filename or "upload").stem
    book = parse_book(text, source_name)

    base = library_dir()
    book_id = new_book_id()
    meta = _build_metadata(
        book_id,
        book,
        title,
        author,
        language,
        description,
        publisher,
        tags,
        published,
        isbn,
        rating,
    )

    save_book(book, base, book_id)
    save_metadata(meta, base)
    write_source_text(base, book_id, text)
    build_epub(book, meta, epub_path(base, book_id))

    if _is_htmx(request):
        return templates.TemplateResponse(
            "partials/book_card.html",
            {"request": request, "book": meta},
        )

    return RedirectResponse(url=f"/book/{book_id}", status_code=303)


@app.get("/book/{book_id}", response_class=HTMLResponse)
async def book_detail(request: Request, book_id: str) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    meta = load_metadata(base, book_id)
    book = load_book(base, book_id)
    sections = _book_sections(book)
    return templates.TemplateResponse(
        "book.html",
        {"request": request, "book": meta, "sections": sections, "book_id": book_id},
    )


@app.get("/book/{book_id}/download")
async def download(book_id: str) -> FileResponse:
    base = library_dir()
    _require_book(base, book_id)
    epub_file = epub_path(base, book_id)
    if not epub_file.exists():
        raise HTTPException(status_code=404, detail="EPUB missing")
    return FileResponse(path=epub_file, filename=epub_file.name, media_type="application/epub+zip")


@app.get("/book/{book_id}/preview")
async def preview_first(book_id: str) -> RedirectResponse:
    base = library_dir()
    _require_book(base, book_id)
    book = load_book(base, book_id)
    sections = _book_sections(book)
    if not sections:
        raise HTTPException(status_code=404, detail="No sections")
    return RedirectResponse(url=f"/book/{book_id}/preview/0", status_code=303)


@app.get("/book/{book_id}/preview/{section_index}", response_class=HTMLResponse)
async def preview(request: Request, book_id: str, section_index: int) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    meta = load_metadata(base, book_id)
    book = load_book(base, book_id)
    sections = _book_sections(book)

    if section_index < 0 or section_index >= len(sections):
        raise HTTPException(status_code=404, detail="Section not found")

    current = sections[section_index]
    prev_idx = section_index - 1 if section_index > 0 else None
    next_idx = section_index + 1 if section_index < len(sections) - 1 else None

    return templates.TemplateResponse(
        "preview.html",
        {
            "request": request,
            "book": meta,
            "section": current,
            "section_index": section_index,
            "prev_idx": prev_idx,
            "next_idx": next_idx,
        },
    )


@app.get("/book/{book_id}/edit", response_class=HTMLResponse)
async def edit_metadata(request: Request, book_id: str) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    meta = load_metadata(base, book_id)
    template = "partials/meta_edit.html" if _is_htmx(request) else "edit.html"
    return templates.TemplateResponse(
        template,
        {
            "request": request,
            "book": meta,
            "book_id": book_id,
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
    publisher: str = Form(""),
    tags: str = Form(""),
    published: str = Form(""),
    isbn: str = Form(""),
    rating: str = Form(""),
) -> HTMLResponse:
    base = library_dir()
    _require_book(base, book_id)
    meta = load_metadata(base, book_id)
    book = load_book(base, book_id)

    meta.title = title.strip() or book.title or "未命名"
    meta.author = author.strip() or None
    meta.language = language.strip() or "zh-CN"
    meta.description = description.strip() or None
    meta.publisher = publisher.strip() or None
    meta.tags = _parse_tags(tags)
    meta.published = published.strip() or None
    meta.isbn = isbn.strip() or None
    meta.rating = _parse_rating(rating)
    meta.updated_at = _now_iso()

    save_metadata(meta, base)
    build_epub(book, meta, epub_path(base, book_id))

    if _is_htmx(request):
        return templates.TemplateResponse(
            "partials/meta_view.html",
            {"request": request, "book": meta, "book_id": book_id},
        )

    return RedirectResponse(url=f"/book/{book_id}", status_code=303)
