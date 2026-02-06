import asyncio
import os
import tempfile
import unittest
import uuid
from pathlib import Path

from starlette.requests import Request

from bindery.models import Metadata
from bindery.storage import load_metadata, save_metadata
from bindery.web import rule_delete, theme_delete


class TemplateCrudTests(unittest.TestCase):
    def test_cannot_delete_referenced_rule_template(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev_rules = os.environ.get("BINDERY_RULES_DIR")
            prev_lib = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_RULES_DIR"] = str(Path(tmp) / "rules")
            os.environ["BINDERY_LIBRARY_DIR"] = str(Path(tmp) / "library")
            try:
                rules_dir = Path(os.environ["BINDERY_RULES_DIR"])
                rules_dir.mkdir(parents=True, exist_ok=True)
                # Create a custom rule template file
                rule_id = "custom-test"
                (rules_dir / f"{rule_id}.json").write_text(
                    """{
  "id": "custom-test",
  "name": "Custom",
  "version": "1",
  "chapter_patterns": ["^第.*章.*$"],
  "volume_patterns": [],
  "special_headings": [],
  "heading_max_len": 40,
  "heading_max_commas": 1,
  "skip_candidate_re": "test"
}""",
                    encoding="utf-8",
                )

                # Create a book referencing it
                book_id = uuid.uuid4().hex
                meta = Metadata(
                    book_id=book_id,
                    title="t",
                    author=None,
                    language="zh-CN",
                    description=None,
                    rule_template=rule_id,
                )
                save_metadata(meta, Path(os.environ["BINDERY_LIBRARY_DIR"]))

                req = Request({"type": "http", "method": "POST", "headers": []})
                resp = asyncio.run(rule_delete(req, rule_id))
                self.assertEqual(getattr(resp, "status_code", None), 303)
                location = resp.headers.get("location", "")
                self.assertIn("/rules?tab=parsing", location)
                self.assertIn(f"rule_id={rule_id}", location)
                self.assertIn("error=", location)

                # Still present
                self.assertTrue((rules_dir / f"{rule_id}.json").exists())
            finally:
                if prev_rules is None:
                    os.environ.pop("BINDERY_RULES_DIR", None)
                else:
                    os.environ["BINDERY_RULES_DIR"] = prev_rules
                if prev_lib is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev_lib

    def test_cannot_delete_referenced_theme_template(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev_themes = os.environ.get("BINDERY_THEMES_DIR")
            prev_lib = os.environ.get("BINDERY_LIBRARY_DIR")
            os.environ["BINDERY_THEMES_DIR"] = str(Path(tmp) / "themes")
            os.environ["BINDERY_LIBRARY_DIR"] = str(Path(tmp) / "library")
            try:
                themes_dir = Path(os.environ["BINDERY_THEMES_DIR"])
                themes_dir.mkdir(parents=True, exist_ok=True)
                theme_id = "theme-test"
                (themes_dir / f"{theme_id}.json").write_text(
                    """{
  "id": "theme-test",
  "name": "Theme",
  "version": "1",
  "css": "body { color: red; }"
}""",
                    encoding="utf-8",
                )

                book_id = uuid.uuid4().hex
                meta = Metadata(
                    book_id=book_id,
                    title="t",
                    author=None,
                    language="zh-CN",
                    description=None,
                    theme_template=theme_id,
                )
                save_metadata(meta, Path(os.environ["BINDERY_LIBRARY_DIR"]))

                req = Request({"type": "http", "method": "POST", "headers": []})
                resp = asyncio.run(theme_delete(req, theme_id))
                self.assertEqual(getattr(resp, "status_code", None), 303)
                location = resp.headers.get("location", "")
                self.assertIn("/rules?tab=themes", location)
                self.assertIn(f"theme_id={theme_id}", location)
                self.assertIn("error=", location)

                self.assertTrue((themes_dir / f"{theme_id}.json").exists())
                meta2 = load_metadata(Path(os.environ["BINDERY_LIBRARY_DIR"]), book_id)
                self.assertEqual(meta2.theme_template, theme_id)
            finally:
                if prev_themes is None:
                    os.environ.pop("BINDERY_THEMES_DIR", None)
                else:
                    os.environ["BINDERY_THEMES_DIR"] = prev_themes
                if prev_lib is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev_lib


if __name__ == "__main__":
    unittest.main()
