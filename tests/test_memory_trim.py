import unittest
from unittest.mock import patch

import bindery.web as web_module


class MemoryTrimTests(unittest.TestCase):
    def test_trim_enabled_by_default_runs_gc(self) -> None:
        with patch.dict("os.environ", {}, clear=False):
            with (
                patch("bindery.web.gc.collect") as mock_gc,
                patch("bindery.web._resolve_malloc_trim", return_value=None),
            ):
                web_module._maybe_trim_process_memory()
            mock_gc.assert_called_once()

    def test_trim_disabled_skips_gc(self) -> None:
        with patch.dict("os.environ", {"BINDERY_MEMORY_TRIM": "0"}, clear=False):
            with patch("bindery.web.gc.collect") as mock_gc:
                web_module._maybe_trim_process_memory()
            mock_gc.assert_not_called()

    def test_trim_invokes_malloc_trim_when_available(self) -> None:
        called = {"count": 0}

        def fake_trim(_pad: int) -> int:
            called["count"] += 1
            return 1

        with patch.dict("os.environ", {"BINDERY_MEMORY_TRIM": "1"}, clear=False):
            with (
                patch("bindery.web.gc.collect"),
                patch("bindery.web._resolve_malloc_trim", return_value=fake_trim),
            ):
                web_module._maybe_trim_process_memory()
        self.assertEqual(called["count"], 1)


if __name__ == "__main__":
    unittest.main()
