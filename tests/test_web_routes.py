import unittest
from pathlib import Path

from bindery.web import app


class WebRoutesTests(unittest.TestCase):
    def test_ingest_routes_registered(self) -> None:
        seen: set[tuple[str, str]] = set()
        for route in app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None) or set()
            for method in methods:
                if path in {"/ingest", "/ingest/preview"}:
                    seen.add((method, path))
        self.assertIn(("GET", "/ingest"), seen)
        self.assertIn(("POST", "/ingest"), seen)
        self.assertIn(("POST", "/ingest/preview"), seen)

    def test_base_template_links_ingest(self) -> None:
        root = Path(__file__).resolve().parent.parent
        base = (root / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn('href="/ingest"', base)

    def test_index_does_not_embed_ingest_forms(self) -> None:
        root = Path(__file__).resolve().parent.parent
        index = (root / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertNotIn('action="/upload"', index)
        self.assertNotIn('action="/upload/epub"', index)

    def test_ingest_template_has_single_file_input(self) -> None:
        root = Path(__file__).resolve().parent.parent
        ingest = (root / "templates" / "ingest.html").read_text(encoding="utf-8")
        self.assertIn('action="/ingest"', ingest)
        self.assertNotIn('action="/upload"', ingest)
        self.assertNotIn('action="/upload/epub"', ingest)
        self.assertIn('accept=".txt,.epub"', ingest)
        self.assertIn('hx-post="/ingest/preview"', ingest)
        self.assertIn('name="custom_css"', ingest)

    def test_theme_editor_routes_registered(self) -> None:
        seen: set[tuple[str, str]] = set()
        for route in app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None) or set()
            if path == "/themes/{theme_id}/editor":
                for method in methods:
                    seen.add((method, path))
        self.assertIn(("GET", "/themes/{theme_id}/editor"), seen)
        self.assertIn(("POST", "/themes/{theme_id}/editor"), seen)

    def test_rules_and_theme_crud_routes_registered(self) -> None:
        seen: set[tuple[str, str]] = set()
        for route in app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None) or set()
            for method in methods:
                if path in {
                    "/rules/{rule_id}/editor",
                    "/rules/new",
                    "/rules/{rule_id}/delete",
                    "/themes/new",
                    "/themes/{theme_id}/delete",
                }:
                    seen.add((method, path))
        self.assertIn(("GET", "/rules/{rule_id}/editor"), seen)
        self.assertIn(("POST", "/rules/{rule_id}/editor"), seen)
        self.assertIn(("POST", "/rules/new"), seen)
        self.assertIn(("POST", "/rules/{rule_id}/delete"), seen)
        self.assertIn(("POST", "/themes/new"), seen)
        self.assertIn(("POST", "/themes/{theme_id}/delete"), seen)


if __name__ == "__main__":
    unittest.main()
