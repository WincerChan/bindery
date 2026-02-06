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
        self.assertIn("data-file-feedback", ingest)
        self.assertIn("data-ingest-submit", ingest)
        self.assertIn("data-ingest-error", ingest)
        self.assertIn("data-ingest-preview-status", ingest)
        self.assertIn("data-ingest-status", ingest)
        self.assertIn("data-upload-tokens", ingest)
        self.assertIn("data-theme-select", ingest)
        self.assertIn('name="dedupe_mode"', ingest)
        self.assertIn("data-dedupe-mode", ingest)
        self.assertIn('data-duplicate-hit="1"', ingest)
        self.assertIn("setSelectedFilesFeedback", ingest)
        self.assertIn("syncUploadTokensFromPreview", ingest)
        self.assertIn("autoSelectThemeByFiles", ingest)
        self.assertIn("KEEP_BOOK_THEME_VALUE = '__book__'", ingest)
        self.assertIn("DEFAULT_THEME_VALUE = 'default'", ingest)
        self.assertIn("input.name = 'upload_tokens'", ingest)
        self.assertIn("htmx:responseError", ingest)
        self.assertIn("status === 413", ingest)
        self.assertNotIn("覆盖元数据（可选）", ingest)
        self.assertNotIn('name="language"', ingest)
        self.assertNotIn('name="rating"', ingest)
        self.assertNotIn('name="title"', ingest)
        self.assertNotIn('name="author"', ingest)
        self.assertNotIn('name="description"', ingest)

    def test_jobs_template_uses_tabs_and_list_layout(self) -> None:
        root = Path(__file__).resolve().parent.parent
        jobs = (root / "templates" / "jobs.html").read_text(encoding="utf-8")
        self.assertIn('href="/jobs?tab={{ tab.key }}&page=1"', jobs)
        self.assertIn("job.book_title", jobs)
        self.assertIn("job.book_author", jobs)
        self.assertIn("job.action_label", jobs)
        self.assertIn("作者：{{ job.book_author }}", jobs)
        self.assertIn("清空失效历史任务", jobs)
        self.assertIn('action="/jobs/cleanup-invalid"', jobs)
        self.assertIn("第 {{ page }} / {{ total_pages }} 页", jobs)

    def test_jobs_cleanup_route_registered(self) -> None:
        seen: set[tuple[str, str]] = set()
        for route in app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None) or set()
            if path in {"/jobs/cleanup-invalid"}:
                for method in methods:
                    seen.add((method, path))
        self.assertIn(("POST", "/jobs/cleanup-invalid"), seen)

    def test_library_route_registered(self) -> None:
        seen: set[tuple[str, str]] = set()
        for route in app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None) or set()
            if path == "/library":
                for method in methods:
                    seen.add((method, path))
        self.assertIn(("GET", "/library"), seen)

    def test_archive_bulk_delete_route_registered(self) -> None:
        seen: set[tuple[str, str]] = set()
        for route in app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None) or set()
            if path == "/archive/delete-bulk":
                for method in methods:
                    seen.add((method, path))
        self.assertIn(("POST", "/archive/delete-bulk"), seen)

    def test_archive_template_has_bulk_delete_controls(self) -> None:
        root = Path(__file__).resolve().parent.parent
        archive = (root / "templates" / "archive.html").read_text(encoding="utf-8")
        self.assertIn('action="/archive/delete-bulk"', archive)
        self.assertIn("data-archive-select", archive)
        self.assertIn("data-archive-bulk-delete", archive)

    def test_library_section_template_has_pagination_text(self) -> None:
        root = Path(__file__).resolve().parent.parent
        section = (root / "templates" / "partials" / "library_section.html").read_text(encoding="utf-8")
        self.assertIn("第 {{ page }} / {{ total_pages }} 页", section)
        self.assertIn("上一页", section)
        self.assertIn("下一页", section)

    def test_bulk_book_routes_registered(self) -> None:
        seen: set[tuple[str, str]] = set()
        for route in app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None) or set()
            if path in {"/books/archive", "/books/download"}:
                for method in methods:
                    seen.add((method, path))
        self.assertIn(("POST", "/books/archive"), seen)
        self.assertIn(("POST", "/books/download"), seen)

    def test_read_status_route_registered(self) -> None:
        seen: set[tuple[str, str]] = set()
        for route in app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None) or set()
            if path == "/book/{book_id}/read":
                for method in methods:
                    seen.add((method, path))
        self.assertIn(("POST", "/book/{book_id}/read"), seen)

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
