"""Offline worker parity harness. Writes only to the temp directory supplied by Vitest."""
import json
import os
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1])
input_data = json.loads((root / "input.json").read_text())
base = root / "python"
os.environ["BINDERY_LIBRARY_DIR"] = str(base)
os.environ["BINDERY_DB_PATH"] = str(base / "db.sqlite")
os.environ["BINDERY_TEMPLATE_DIR"] = str(root / "templates")
os.environ["BINDERY_STAGE_DIR"] = str(root / "stage")
for key in ("BINDERY_RULES_DIR", "BINDERY_THEMES_DIR"):
    os.environ.pop(key, None)
    os.environ.pop(key + "_FILE", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from bindery.db import init_db, create_job, get_job, get_wish_by_library_book_id
from bindery.models import Job
from bindery.storage import load_metadata
from bindery.web import _process_queued_ingest_task

init_db()
book_id = input_data["book_id"]
job_id = "c" * 32
payload = base / ".ingest-queue" / job_id / input_data["filename"]
payload.parent.mkdir(parents=True)
shutil.copyfile(root / "source.txt", payload)
fields = input_data["fields"]
job = Job(id=job_id, book_id=book_id, action="upload", status="running", stage="排队中", message=None, log=None, rule_template=fields["rule_template"], created_at="", updated_at="")
create_job(job)
_process_queued_ingest_task({"job_id": job_id, "kind": "txt", "filename": input_data["filename"], "payload_path": str(payload), "content_type": "text/plain", "dedupe_mode": "keep", **fields})
job = get_job(job_id)
if job.status != "success":
    raise RuntimeError(job.log)
meta = load_metadata(base, book_id)
if input_data.get("regenerate"):
    from bindery.web import _run_regenerate
    _run_regenerate(job, base, book_id, fields["rule_template"])
    meta = load_metadata(base, book_id)
(root / "reference.json").write_text(json.dumps({"meta": meta.__dict__, "job": job.__dict__, "wish": get_wish_by_library_book_id(book_id).__dict__}, ensure_ascii=False))
