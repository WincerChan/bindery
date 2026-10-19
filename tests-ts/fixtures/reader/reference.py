"""Offline reference driver; all paths belong to the test's temporary library."""
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
root, mode, payload_path = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
os.environ["BINDERY_LIBRARY_DIR"] = str(root / "library")
os.environ["BINDERY_DB_PATH"] = str(root / "db.sqlite")
os.environ["BINDERY_TEMPLATE_DIR"] = str(root / "templates")
os.environ["BINDERY_RULES_DIR"] = str(root / "templates" / "rules")
os.environ["BINDERY_THEMES_DIR"] = str(root / "templates" / "themes")
from starlette.requests import Request
from bindery import web
from bindery.db import get_reader_progress

args = json.loads(payload_path.read_text())
book_id = "d" * 32


def request(path, payload=None, query=""):
    async def receive():
        return {"type": "http.request", "body": json.dumps(payload).encode(), "more_body": False}

    return Request({"type": "http", "method": "POST" if payload is not None else "GET", "path": path, "query_string": query.encode(), "headers": []}, receive)


if mode == "search":
    outputs = []
    for query, limit, offset in args:
        outputs.append(asyncio.run(web.search_book(book_id, q=query, limit=limit, offset=offset)))
    print(json.dumps(outputs, ensure_ascii=False))
elif mode == "progress":
    web._now_iso = lambda: "2026-10-19T12:00:00+00:00"
    output = []
    for payload in args:
        result = asyncio.run(web.save_reader_progress(request("/", payload), book_id))
        output.append({"response": result, "row": get_reader_progress(book_id)})
    print(json.dumps(output, ensure_ascii=False))
elif mode == "preview":
    first = asyncio.run(web.preview_first(request("/", query=args), book_id))
    page = asyncio.run(web.preview(request("/"), book_id, 0))
    print(json.dumps({"status": first.status_code, "location": first.headers["location"], "headers": dict(first.headers), "progress": page.context["initial_progress"], "sections": page.context["sections_payload"]}, ensure_ascii=False))
elif mode == "text":
    print(json.dumps([web._extract_text_from_html_bytes(text.encode()) for text in args], ensure_ascii=False))
