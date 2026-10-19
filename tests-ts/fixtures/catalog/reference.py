"""Offline catalog parity probe. Every write is rooted in the caller's temp directory."""
import asyncio
import dataclasses
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
root = Path(sys.argv[2])
root.mkdir(parents=True, exist_ok=True)
for key, value in {
    "BINDERY_LIBRARY_DIR": root / "library",
    "BINDERY_DB_PATH": root / "data.db",
    "BINDERY_TEMPLATE_DIR": root / "templates",
    "BINDERY_RULES_DIR": root / "templates/rules",
    "BINDERY_THEMES_DIR": root / "templates/themes",
}.items():
    os.environ[key] = str(value)
    os.environ.pop(key + "_FILE", None)

from starlette.requests import Request
from bindery import web
from bindery.db import init_db, list_wishes, get_wish, update_wish
from bindery.models import Metadata
from bindery.parsing import parse_book
from bindery.storage import save_book, save_metadata, load_metadata, delete_book
from bindery.rules import load_rule_templates
from bindery.themes import load_theme_templates
from bindery.css import validate_css

init_db()
request = Request({"type": "http", "method": "POST", "path": "/rules", "headers": []})
base = root / "library"
run = asyncio.run

def book(book_id, title, author):
    save_book(parse_book("第一章 开始\n正文", title), base, book_id)
    save_metadata(Metadata(book_id=book_id, title=title, author=author, language="zh-CN", description=None), base)

def clean_redirect(response):
    return [response.status_code, re.sub(r"[a-f0-9]{32}", "<id>", response.headers["location"])]

if sys.argv[1] == "tracker":
    results = []
    def create(**fields):
        defaults = dict(title="", library_book_id="", author="", tags="", rating="", comment="", read_status="", read="0", book_status="completed", next="")
        defaults.update(fields)
        response = run(web.tracker_create(**defaults))
        results.append(clean_redirect(response))
    def update(wish_id, **fields):
        defaults = dict(title="", library_book_id="", author="", tags="", rating="", comment="", read_status="", read="0", book_status="completed", next="")
        defaults.update(fields)
        results.append(clean_redirect(run(web.tracker_update(wish_id, **defaults))))
    create(title="三体", author="刘慈欣", tags=" 科幻，SCI, sci\n重读", rating="5", comment='准备\n"重读"', read_status="read")
    original = list_wishes()[0].id
    create(title="三 体", author="刘慈欣", next="/wishlist?q=x&page=2#fragment")
    create(title="三体", author="另一作者")
    create(title="球状闪电", author="刘慈欣")
    second = next(w for w in list_wishes() if w.title == "球状闪电")
    update(second.id, title="三体", author="刘慈欣", tags="合并后", rating="3", comment="应保留单条", read_status="read")
    merged_kept_id = get_wish(original) is not None and get_wish(second.id) is None
    linked_id = "c" * 32
    book(linked_id, "库内原名", "库作者")
    before = (base / linked_id / "book.json").read_bytes()
    create(title="忽略", author="忽略", library_book_id=linked_id, read_status="read", rating="4")
    linked = next(w for w in list_wishes() if w.library_book_id == linked_id)
    update(linked.id, title="忽略更新", read_status="reading", rating="5")
    meta = load_metadata(base, linked_id)
    meta.title = "库内新名"
    save_metadata(meta, base)
    create(title="同名待关联", tags="保留", rating="4", read_status="unread")
    book("d" * 32, "同名待关联", "作者甲")
    book("e" * 32, "同名待关联", "作者乙")
    page_request = Request({"type": "http", "method": "GET", "path": "/tracker", "headers": []})
    page = run(web.tracker_page(page_request, q="", read_filter="all", library_filter="all", book_status_filter="all", page=1, duplicate=original)).context
    rows = []
    for wish in list_wishes():
        row = dataclasses.asdict(wish)
        for key in ["id", "created_at", "updated_at"]:
            row.pop(key, None)
        rows.append(row)
        update_wish(wish.id, updated_at="2026-04-01T10:00:00+00:00")
    rows.sort(key=lambda row: (row["title"], row["author"] or ""))
    duplicate = json.loads(run(web.tracker_duplicate_check(title="三体", author="刘慈欣", limit=5)).body)
    for key in ["matches", "blocking_matches", "exact_matches"]:
        for row in duplicate[key]:
            row.pop("id", None)
    csv = run(web.tracker_export(q="", read_filter="reading", library_filter="all", book_status_filter="all")).body.decode("utf-8")
    meta = load_metadata(base, linked_id)
    print(json.dumps(dict(results=results, rows=rows, stats=page["stats"], duplicate=duplicate, csv=csv, merged_kept_id=merged_kept_id, metadata=dict(title=meta.title, read=meta.read, rating=meta.rating), book_unchanged=before == (base / linked_id / "book.json").read_bytes()), ensure_ascii=False))
elif sys.argv[1] == "templates":
    load_rule_templates()
    load_theme_templates()
    target = run(web.rule_new(request)).headers["location"]
    rule_id = target.split("rule_id=")[1]
    raw = json.dumps(dict(id=rule_id, name="规则", chapter_patterns=["^第.*章.*$"], volume_patterns=[], special_headings=[], heading_max_len="40", heading_max_commas="1", skip_candidate_re="广告", extra={"keep": True}), ensure_ascii=False)
    saved = run(web.rule_editor_save(request, rule_id, config_json=raw)).context
    rule_data = json.loads((root / f"templates/rules/{rule_id}.json").read_text())
    rule_data["id"] = "<rule>"
    before = (root / f"templates/rules/{rule_id}.json").read_bytes()
    rejected = run(web.rule_editor_save(request, rule_id, config_json="{bad")).context
    invalid_unchanged = before == (root / f"templates/rules/{rule_id}.json").read_bytes()
    preview = run(web.rules_test(request, sample="第一章 开始\n正文\n第二章 继续\n正文", rule_template=rule_id)).context["preview"]
    theme_id = run(web.theme_new(request)).headers["location"].split("theme_id=")[1]
    css = '/* { */\np { content:"}"; color:blue; }\n\n'
    theme_saved = run(web.theme_editor_save(request, theme_id, css=css)).context["saved"]
    before = (root / f"templates/themes/{theme_id}.json").read_bytes()
    theme_bad = run(web.theme_editor_save(request, theme_id, css="p {")).context
    theme_unchanged = before == (root / f"templates/themes/{theme_id}.json").read_bytes()
    theme_data = json.loads(before)
    theme_data["id"] = "<theme>"
    save_metadata(Metadata(book_id="a" * 32, title="归档引用", author=None, language="zh-CN", description=None, archived=True, theme_template=theme_id), base)
    blocked = run(web.theme_delete(request, theme_id)).headers["location"]
    delete_book(base, "a" * 32)
    deleted = run(web.theme_delete(request, theme_id)).headers["location"]
    cases = ["", "   ", "body { color:red; }", "body {", "}body{}", 'p{content:"x}', "/* nope", "p{\0}", "a" * 200001, "😀" * 100001]
    print(json.dumps(dict(saved=saved["saved"], rule=rule_data, invalid_unchanged=invalid_unchanged, rejected_raw=rejected["raw_json"], preview=preview, theme_saved=theme_saved, theme=theme_data, theme_error=theme_bad["error"], theme_unchanged=theme_unchanged, blocked="error=" in blocked, deleted=deleted, css_validation=[validate_css(value) for value in cases]), ensure_ascii=False))
