import os
import tempfile
import unittest

from bindery.db import create_job, get_job, init_db, list_jobs
from bindery.models import Job


class DbTests(unittest.TestCase):
    def test_jobs_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "bindery.db")
            os.environ["BINDERY_DB_PATH"] = db_path
            try:
                init_db()
                job = Job(
                    id="job1",
                    book_id="book1",
                    action="upload",
                    status="running",
                    stage="预处理",
                    message=None,
                    log=None,
                    rule_template="default",
                    created_at="now",
                    updated_at="now",
                )
                create_job(job)
                fetched = get_job("job1")
                self.assertIsNotNone(fetched)
                self.assertEqual(fetched.book_id, "book1")
                self.assertEqual(len(list_jobs()), 1)
            finally:
                del os.environ["BINDERY_DB_PATH"]


if __name__ == "__main__":
    unittest.main()
