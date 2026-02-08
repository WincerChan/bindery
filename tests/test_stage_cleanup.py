import os
import tempfile
import unittest
from pathlib import Path

import bindery.web as web_module


class StageCleanupTests(unittest.TestCase):
    def test_cleanup_expired_staged_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_stage = os.environ.get("BINDERY_STAGE_DIR")
            os.environ["BINDERY_STAGE_DIR"] = os.path.join(tmp, "stage")
            try:
                base = Path(tmp)
                stage_root = web_module._staged_upload_dir(base)
                old_dir = stage_root / "old-token"
                new_dir = stage_root / "new-token"
                old_dir.mkdir(parents=True, exist_ok=True)
                new_dir.mkdir(parents=True, exist_ok=True)
                old_file = old_dir / "payload.txt"
                new_file = new_dir / "payload.txt"
                old_file.write_text("old", encoding="utf-8")
                new_file.write_text("new", encoding="utf-8")
                os.utime(old_dir, (100.0, 100.0))
                os.utime(new_dir, (190.0, 190.0))

                removed = web_module._cleanup_expired_staged_uploads(base, ttl_seconds=60, now_ts=200.0)

                self.assertEqual(removed, 1)
                self.assertFalse(old_dir.exists())
                self.assertTrue(new_dir.exists())
            finally:
                if previous_stage is None:
                    os.environ.pop("BINDERY_STAGE_DIR", None)
                else:
                    os.environ["BINDERY_STAGE_DIR"] = previous_stage

    def test_cleanup_disabled_when_ttl_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_stage = os.environ.get("BINDERY_STAGE_DIR")
            os.environ["BINDERY_STAGE_DIR"] = os.path.join(tmp, "stage")
            try:
                base = Path(tmp)
                stage_root = web_module._staged_upload_dir(base)
                item = stage_root / "token"
                item.mkdir(parents=True, exist_ok=True)
                removed = web_module._cleanup_expired_staged_uploads(base, ttl_seconds=0, now_ts=10.0)
                self.assertEqual(removed, 0)
                self.assertTrue(item.exists())
            finally:
                if previous_stage is None:
                    os.environ.pop("BINDERY_STAGE_DIR", None)
                else:
                    os.environ["BINDERY_STAGE_DIR"] = previous_stage


if __name__ == "__main__":
    unittest.main()
