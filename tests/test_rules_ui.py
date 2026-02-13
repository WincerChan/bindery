import unittest
from pathlib import Path


class RulesUiTests(unittest.TestCase):
    def test_rules_template_has_actions_and_editors(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "rules.html").read_text(encoding="utf-8")

        # CRUD actions
        self.assertIn('action="/rules/new"', tpl)
        self.assertIn("'/rules/' + ruleId + '/delete'", tpl)
        self.assertIn('action="/themes/new"', tpl)
        self.assertIn("'/themes/' + themeId + '/delete'", tpl)
        self.assertIn('action="/books/regenerate"', tpl)
        self.assertIn('name="scope"', tpl)
        self.assertIn('name="template_id"', tpl)

        # Rule editor (HTMX loaded)
        self.assertIn('id="rule-editor"', tpl)
        self.assertIn('hx-get="/rules/{{ rule.rule_id }}/editor"', tpl)
        self.assertIn('hx-get="/rules/{{ initial_rule }}/editor"', tpl)

        # Theme editor (HTMX loaded)
        self.assertIn('id="theme-editor"', tpl)
        self.assertIn('hx-get="/themes/{{ initial_theme }}/editor"', tpl)


if __name__ == "__main__":
    unittest.main()
