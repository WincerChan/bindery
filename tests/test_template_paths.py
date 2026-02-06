import os
import tempfile
import unittest
from pathlib import Path

from bindery.rules import load_rule_templates, rules_dir
from bindery.themes import load_theme_templates, themes_dir


class TemplatePathTests(unittest.TestCase):
    def test_rules_and_themes_share_parent_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev_library = os.environ.get("BINDERY_LIBRARY_DIR")
            prev_template = os.environ.get("BINDERY_TEMPLATE_DIR")
            prev_rules = os.environ.get("BINDERY_RULES_DIR")
            prev_themes = os.environ.get("BINDERY_THEMES_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ.pop("BINDERY_TEMPLATE_DIR", None)
            os.environ.pop("BINDERY_RULES_DIR", None)
            os.environ.pop("BINDERY_THEMES_DIR", None)
            try:
                expected_parent = Path(tmp) / "templates"
                self.assertEqual(rules_dir(), expected_parent / "rules")
                self.assertEqual(themes_dir(), expected_parent / "themes")
                self.assertEqual(rules_dir().parent, themes_dir().parent)
                self.assertTrue(load_rule_templates())
                self.assertTrue(load_theme_templates())
            finally:
                if prev_library is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev_library
                if prev_template is None:
                    os.environ.pop("BINDERY_TEMPLATE_DIR", None)
                else:
                    os.environ["BINDERY_TEMPLATE_DIR"] = prev_template
                if prev_rules is None:
                    os.environ.pop("BINDERY_RULES_DIR", None)
                else:
                    os.environ["BINDERY_RULES_DIR"] = prev_rules
                if prev_themes is None:
                    os.environ.pop("BINDERY_THEMES_DIR", None)
                else:
                    os.environ["BINDERY_THEMES_DIR"] = prev_themes

    def test_individual_dir_env_overrides_parent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prev_library = os.environ.get("BINDERY_LIBRARY_DIR")
            prev_template = os.environ.get("BINDERY_TEMPLATE_DIR")
            prev_rules = os.environ.get("BINDERY_RULES_DIR")
            prev_themes = os.environ.get("BINDERY_THEMES_DIR")
            os.environ["BINDERY_LIBRARY_DIR"] = tmp
            os.environ["BINDERY_TEMPLATE_DIR"] = str(Path(tmp) / "merged")
            os.environ["BINDERY_RULES_DIR"] = str(Path(tmp) / "custom-rules")
            os.environ.pop("BINDERY_THEMES_DIR", None)
            try:
                self.assertEqual(rules_dir(), Path(tmp) / "custom-rules")
                self.assertEqual(themes_dir(), Path(tmp) / "merged" / "themes")
            finally:
                if prev_library is None:
                    os.environ.pop("BINDERY_LIBRARY_DIR", None)
                else:
                    os.environ["BINDERY_LIBRARY_DIR"] = prev_library
                if prev_template is None:
                    os.environ.pop("BINDERY_TEMPLATE_DIR", None)
                else:
                    os.environ["BINDERY_TEMPLATE_DIR"] = prev_template
                if prev_rules is None:
                    os.environ.pop("BINDERY_RULES_DIR", None)
                else:
                    os.environ["BINDERY_RULES_DIR"] = prev_rules
                if prev_themes is None:
                    os.environ.pop("BINDERY_THEMES_DIR", None)
                else:
                    os.environ["BINDERY_THEMES_DIR"] = prev_themes


if __name__ == "__main__":
    unittest.main()
