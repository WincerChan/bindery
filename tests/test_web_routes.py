import unittest
from pathlib import Path

from bindery.web import app


class WebRoutesTests(unittest.TestCase):
    def test_ingest_route_registered(self) -> None:
        for route in app.routes:
            if getattr(route, "path", None) != "/ingest":
                continue
            methods = getattr(route, "methods", None) or set()
            if "GET" in methods:
                return
        self.fail("GET /ingest route not registered")

    def test_base_template_links_ingest(self) -> None:
        root = Path(__file__).resolve().parent.parent
        base = (root / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn('href="/ingest"', base)

    def test_index_does_not_embed_ingest_forms(self) -> None:
        root = Path(__file__).resolve().parent.parent
        index = (root / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertNotIn('action="/upload"', index)
        self.assertNotIn('action="/upload/epub"', index)


if __name__ == "__main__":
    unittest.main()

