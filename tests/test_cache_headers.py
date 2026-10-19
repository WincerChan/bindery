import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from bindery.web import app, _cover_browser_cache_headers, _edge_bypass_browser_revalidate_headers


class CacheHeaderTests(unittest.TestCase):
    def test_static_css_requires_browser_revalidation(self) -> None:
        # Do not enter the lifespan context: this request needs no DB or workers.
        client = TestClient(app)
        self.addCleanup(client.close)
        response = client.get("/static/app.css")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-cache")
        self.assertIn("ETag", response.headers)
        self.assertIn("Last-Modified", response.headers)
        self.assertIn("text/css", response.headers["Content-Type"])

    def test_static_css_etag_hit_still_returns_304(self) -> None:
        client = TestClient(app)
        self.addCleanup(client.close)
        original = client.get("/static/app.css")
        self.assertEqual(original.status_code, 200)
        response = client.get("/static/app.css", headers={"If-None-Match": original.headers["ETag"]})
        self.assertEqual(response.status_code, 304)
        self.assertEqual(response.headers["Cache-Control"], "no-cache")
        self.assertEqual(response.headers["ETag"], original.headers["ETag"])
        self.assertEqual(response.content, b"")

    def test_edge_bypass_browser_revalidate_headers(self) -> None:
        headers = _edge_bypass_browser_revalidate_headers()
        self.assertEqual(headers.get("Cache-Control"), "private, no-cache, must-revalidate")
        self.assertEqual(headers.get("CDN-Cache-Control"), "no-store")
        self.assertEqual(headers.get("Cloudflare-CDN-Cache-Control"), "no-store")
        self.assertEqual(headers.get("Pragma"), "no-cache")

    def test_cover_browser_cache_headers(self) -> None:
        headers = _cover_browser_cache_headers()
        self.assertEqual(headers.get("Cache-Control"), "private, max-age=604800, immutable")
        self.assertEqual(headers.get("CDN-Cache-Control"), "no-store")
        self.assertEqual(headers.get("Cloudflare-CDN-Cache-Control"), "no-store")

    def test_cover_and_epub_item_use_revalidate_headers(self) -> None:
        root = Path(__file__).resolve().parent.parent
        web_py = (root / "bindery" / "web.py").read_text(encoding="utf-8")
        self.assertIn("FileResponse(path, headers=_cover_browser_cache_headers())", web_py)
        self.assertIn("response = Response(content=content, media_type=media_type, headers=_edge_bypass_browser_revalidate_headers())", web_py)
        self.assertIn("return response", web_py)


if __name__ == "__main__":
    unittest.main()
