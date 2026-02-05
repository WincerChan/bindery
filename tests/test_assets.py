import unittest
from pathlib import Path


class AssetSetupTests(unittest.TestCase):
    def test_tailwind_assets_exist(self) -> None:
        root = Path(__file__).resolve().parent.parent
        self.assertTrue((root / "tailwind.config.js").exists())
        self.assertTrue((root / "static" / "tailwind.css").exists())
        self.assertTrue((root / "static" / "custom.css").exists())

    def test_procfile_has_port(self) -> None:
        root = Path(__file__).resolve().parent.parent
        procfile = (root / "Procfile").read_text(encoding="utf-8")
        self.assertIn("--port 5678", procfile)


if __name__ == "__main__":
    unittest.main()
