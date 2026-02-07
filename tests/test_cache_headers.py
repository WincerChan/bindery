import unittest
from pathlib import Path

from bindery.web import _edge_bypass_browser_revalidate_headers


class CacheHeaderTests(unittest.TestCase):
    def test_edge_bypass_browser_revalidate_headers(self) -> None:
        headers = _edge_bypass_browser_revalidate_headers()
        self.assertEqual(headers.get("Cache-Control"), "private, no-cache, must-revalidate")
        self.assertEqual(headers.get("CDN-Cache-Control"), "no-store")
        self.assertEqual(headers.get("Cloudflare-CDN-Cache-Control"), "no-store")
        self.assertEqual(headers.get("Pragma"), "no-cache")

    def test_cover_and_epub_item_use_revalidate_headers(self) -> None:
        root = Path(__file__).resolve().parent.parent
        web_py = (root / "bindery" / "web.py").read_text(encoding="utf-8")
        self.assertIn("FileResponse(path, headers=_edge_bypass_browser_revalidate_headers())", web_py)
        self.assertIn(
            "return Response(content=content, media_type=media_type, headers=_edge_bypass_browser_revalidate_headers())",
            web_py,
        )


if __name__ == "__main__":
    unittest.main()
