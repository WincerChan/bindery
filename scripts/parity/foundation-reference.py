"""Read/mutate only a supplied temporary library using the real Python helpers."""
import asyncio
import base64
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
base, database, book_id = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
assert base.is_relative_to(Path(tempfile.gettempdir()).resolve())
assert database.is_relative_to(Path(tempfile.gettempdir()).resolve())
os.environ["BINDERY_LIBRARY_DIR"] = str(base)
os.environ["BINDERY_DB_PATH"] = str(database)

from bindery.storage import load_metadata, epub_path
from bindery.web import _book_view, _book_epub_needs_css_sync, _cover_browser_cache_headers, download

meta = load_metadata(base, book_id)
view = _book_view(meta, base)
view.setdefault("cover_url", None)
before = _book_epub_needs_css_sync(epub_path(base, book_id), meta)
response = asyncio.run(download(book_id))
after = _book_epub_needs_css_sync(epub_path(base, book_id), meta)
with zipfile.ZipFile(epub_path(base, book_id)) as archive:
    members = []
    for name in archive.namelist():
        data = archive.read(name)
        if name.endswith(".opf"):
            data = re.sub(rb'(<(?:\w+:)?meta property="dcterms:modified">)[^<]+', rb'\1TIMESTAMP', data)
        members.append(dict(name=name, data=base64.b64encode(data).decode()))
print(json.dumps(dict(view=view, needs_before=before, needs_after=after, filename=response.filename, headers=_cover_browser_cache_headers(), members=members), ensure_ascii=False))
