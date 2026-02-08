import os
import tempfile
import unittest
from pathlib import Path

import bindery.web as web_module


class StageCleanupTests(unittest.TestCase):
    def test_cleanup_staged_uploads_except_keeps_selected_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous_stage = os.environ.get("BINDERY_STAGE_DIR")
            os.environ["BINDERY_STAGE_DIR"] = os.path.join(tmp, "stage")
            try:
                base = Path(tmp)
                stage_root = web_module._staged_upload_dir(base)
                keep_token = "a" * 32
                remove_token = "b" * 32
                keep_dir = stage_root / keep_token
                remove_dir = stage_root / remove_token
                keep_dir.mkdir(parents=True, exist_ok=True)
                remove_dir.mkdir(parents=True, exist_ok=True)
                removed = web_module._cleanup_staged_uploads_except(base, [keep_token])

                self.assertEqual(removed, 1)
                self.assertTrue(keep_dir.exists())
                self.assertFalse(remove_dir.exists())
            finally:
                if previous_stage is None:
                    os.environ.pop("BINDERY_STAGE_DIR", None)
                else:
                    os.environ["BINDERY_STAGE_DIR"] = previous_stage


if __name__ == "__main__":
    unittest.main()
