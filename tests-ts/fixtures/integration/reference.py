"""Shared-layer oracle. Only the supplied temporary directory is writable."""
import asyncio
import json
import os
import sys
from pathlib import Path

root, mode = Path(sys.argv[1]), sys.argv[2]
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
os.environ['BINDERY_LIBRARY_DIR'] = str(root / 'python')
os.environ['BINDERY_DB_PATH'] = str(root / 'python' / 'bindery.db')
os.environ['BINDERY_TEMPLATE_DIR'] = str(root / 'templates')
for name in ('BINDERY_RULES_DIR', 'BINDERY_THEMES_DIR'):
    os.environ.pop(name, None)
    os.environ.pop(name + '_FILE', None)
args = json.loads((root / 'input.json').read_text())
if mode == 'css':
    from bindery.css import validate_css
    result = [validate_css(raw) for raw in args]
else:
    from bindery import web
    from bindery.db import init_db, list_wishes, get_job
    from bindery.storage import load_metadata, list_books
    from starlette.requests import Request
    init_db()
    web._now_iso = lambda: '2026-10-19T12:00:00+00:00'
    base = root / 'python'
    if mode == 'tracker':
        for op, book_id in args:
            request = Request({'type': 'http', 'method': 'GET', 'path': '/', 'query_string': b'', 'headers': []})
            if op == 'library':
                web._library_page_data(base, 'created', '', 1, 'all', 4)
            elif op == 'reader':
                asyncio.run(web.preview(request, book_id, 0))
            elif op == 'detail':
                asyncio.run(web.book_detail(request, book_id))
            elif op == 'edit':
                asyncio.run(web.edit_metadata(request, book_id))
            else:
                web._ensure_tracker_consistency_for_meta(base, load_metadata(base, book_id))
        result = {'books': [m.__dict__ for m in list_books(base)], 'wishes': [w.__dict__ for w in list_wishes()]}
    elif mode == 'edit':
        job = get_job(args['job_id'])
        if args.get('url_bytes'):
            def download(url):
                assert url == args['cover_url']
                return bytes.fromhex(args['url_bytes']), 'download.png'
            web._download_cover_from_url = download
        try:
            web._run_edit_writeback(job, base, args['book_id'], cover_bytes=bytes.fromhex(args['cover_bytes']) if args.get('cover_bytes') else None, cover_name=args['cover_name'], cover_url=args['cover_url'], strip_original_css=args['strip_original_css'])
        except Exception:
            if not args.get('failure'):
                raise
        result = {'meta': load_metadata(base, args['book_id']).__dict__, 'job': get_job(job.id).__dict__}
(root / 'reference.json').write_text(json.dumps(result, ensure_ascii=False))
