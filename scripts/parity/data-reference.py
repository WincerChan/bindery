"""Offline Phase 2 oracle. All mutations are confined to a caller-owned temp tree."""
from __future__ import annotations

import base64
import dataclasses
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bindery import db, storage
from bindery.models import Job, Wish, book_from_dict, metadata_from_dict

root = Path(sys.argv[2]).resolve()
assert root.is_relative_to(Path(tempfile.gettempdir()).resolve()), "Temp directories only"
root.mkdir(parents=True, exist_ok=True)
base = root / "library"
base.mkdir(exist_ok=True)
os.environ["BINDERY_DB_PATH"] = str(root / "data.db")
os.environ["BINDERY_LIBRARY_DIR"] = str(base)
db.BASE_DIR = root / "project"


def encode(value):
    if dataclasses.is_dataclass(value):
        return dataclasses.asdict(value)
    if isinstance(value, bytes):
        return {"blob": value.hex()}
    raise TypeError(type(value))


def snapshot():
    conn = db.connect()
    result = {
        "schema": [dict(r) for r in conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")],
        "pragmas": {key: conn.execute("PRAGMA " + key).fetchone()[0] for key in
                    ("foreign_keys", "busy_timeout", "journal_mode", "synchronous", "trusted_schema", "recursive_triggers", "locking_mode")},
        "tables": {},
        "files": {},
    }
    for table in ("books", "jobs", "sessions", "passkeys", "webauthn_challenges", "app_settings", "reader_progress", "wishlist"):
        result["tables"][table] = [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY 1")]
    for path in sorted(base.rglob("*")):
        if path.is_file():
            result["files"][path.relative_to(base).as_posix()] = path.read_bytes().hex()
    conn.close()
    return result


def run(steps):
    result = []
    for step in steps:
        name, args, kwargs = step["op"], step.get("args", []), step.get("kwargs", {})
        if name == "save_metadata":
            value = storage.save_metadata(metadata_from_dict(args[0]), base)
        elif name == "save_book":
            value = storage.save_book(book_from_dict(args[0]), base, args[1])
        elif name in {"load_metadata", "ensure_book_exists", "archive_book", "delete_book"}:
            value = getattr(storage, name)(base, *args, **kwargs)
        elif name == "load_book":
            from bindery.models import book_to_dict
            value = book_to_dict(storage.load_book(base, *args))
        elif name in {"list_books", "list_books_page", "list_archived_books"}:
            value = getattr(storage, name)(base, **kwargs)
        elif name == "create_job":
            value = db.create_job(Job(**args[0]))
        elif name == "create_wish":
            value = db.create_wish(Wish(**args[0]))
        elif name == "restore_book":
            src, dest = storage.archive_book_dir(base, args[0]), storage.book_dir(base, args[0])
            if not src.exists():
                raise FileNotFoundError("Book not found")
            if dest.exists():
                raise FileExistsError("Book exists")
            src.replace(dest)
            meta = storage.load_metadata(base, args[0])
            meta.archived = False
            meta.updated_at = args[1]
            value = storage.save_metadata(meta, base)
        elif name == "sql":
            conn = db.connect()
            with conn:
                conn.executescript(args[0])
            conn.close()
            value = None
        else:
            value = getattr(db, name)(*args, **kwargs)
        result.append(value)
    return result


mode = sys.argv[1]
if mode == "init":
    db.init_db()
    output = snapshot()
elif mode == "run":
    db.init_db()
    output = {"results": run(json.loads(Path(sys.argv[3]).read_text())), "snapshot": snapshot()}
elif mode == "snapshot":
    output = snapshot()
elif mode == "migrate":
    storage.list_books(base)
    output = snapshot()
elif mode == "copy-existing":
    reference = Path(__file__).resolve().parents[2] / "library" / "bindery.db"
    source = sqlite3.connect(reference.as_uri() + "?mode=ro", uri=True)
    target = db.connect()
    source.backup(target)
    target.close()
    source.close()
    output = {"copied": True}
else:
    raise ValueError(mode)
print(json.dumps(output, ensure_ascii=False, default=encode))
