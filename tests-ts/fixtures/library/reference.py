"""Offline Python oracle for Slice A; all paths come from temporary test data."""
import asyncio
import hashlib
import json
import os
import re
import sys
import zipfile
from dataclasses import asdict
from io import BytesIO
from pathlib import Path

base = Path(sys.argv[2])
os.environ["BINDERY_LIBRARY_DIR"] = str(base)
os.environ["BINDERY_DB_PATH"] = str(base / "bindery.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

import bindery.web as web
from bindery.db import init_db
from bindery.storage import list_books, list_archived_books

init_db()
web._now_iso = lambda: "2026-10-19T01:02:03+00:00"
a, b, c = "a" * 32, "b" * 32, "c" * 32


def digest(data):
    return hashlib.sha256(data).hexdigest()


def epub_members(data):
    with zipfile.ZipFile(BytesIO(data)) as archive:
        result = []
        for name in archive.namelist():
            content = archive.read(name)
            if name.endswith(".opf"):
                content = re.sub(rb'(property="dcterms:modified"[^>]*>)[^<]*(</)', rb'\1MODIFIED\2', content)
            result.append([name, digest(content)])
        return result


def snapshot():
    metadata = sorted([asdict(meta) for meta in list_books(base) + list_archived_books(base)], key=lambda meta: meta["book_id"])
    files = {}
    for prefix in ("", "archive/"):
        for book_id in (a, b, c):
            folder = base / prefix / book_id
            if not folder.exists():
                continue
            for path in sorted(folder.rglob("*")):
                if path.is_file():
                    files[str(path.relative_to(base))] = epub_members(path.read_bytes()) if path.name == "book.epub" else digest(path.read_bytes())
    return dict(metadata=metadata, files=files)


if sys.argv[1] == "pages":
    queries = json.loads(Path(sys.argv[3]).read_text())
    pages = []
    for query in queries:
        payload = web._library_page_data(base, query["sort"], query["q"], query["page"], query["read_filter"], query["per_page"])
        payload["books"] = [{key: book[key] for key in ("book_id", "title", "author", "read", "rating", "status_label", "status_class")} for book in payload["books"]]
        pages.append(payload)
    print(json.dumps(pages, ensure_ascii=False))
else:
    async def run():
        result = {}
        for key, ids in (("empty", []), ("missing", ["d" * 32])):
            try:
                await web.download_bulk(ids)
            except web.HTTPException as error:
                result[key] = [error.status_code, error.detail]
        response = await web.download_bulk([a, b, c, a, "bad-id"])
        with zipfile.ZipFile(BytesIO(response.body)) as archive:
            result["bundle"] = [[name, epub_members(archive.read(name))] for name in archive.namelist()]
        result["downloaded"] = snapshot()
        response = await web.archive_bulk([a, b, "bad-id", a])
        result["archive_response"] = [response.status_code, response.headers["location"]]
        result["archived"] = snapshot()
        response = await web.archive_delete_bulk([a, c, "bad-id"])
        result["delete_response"] = [response.status_code, response.headers["location"]]
        result["deleted"] = snapshot()
        await web.restore_view(b)
        result["restored"] = snapshot()
        return result
    print(json.dumps(asyncio.run(run()), ensure_ascii=False))
