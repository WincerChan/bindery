import unittest
from pathlib import Path


class RuleEditorUiTests(unittest.TestCase):
    def test_rule_editor_partial_has_json_and_test_bench(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "partials" / "rule_editor.html").read_text(encoding="utf-8")

        self.assertIn('action="/rules/{{ rule.rule_id }}/editor"', tpl)
        self.assertIn('hx-post="/rules/{{ rule.rule_id }}/editor"', tpl)
        self.assertIn('name="config_json"', tpl)
        self.assertIn('x-ref="configJson"', tpl)
        self.assertIn('@click="formatJson()"', tpl)
        self.assertIn('JSON.stringify(parsed, null, 2)', tpl)

        self.assertIn('action="/rules/test"', tpl)
        self.assertIn('hx-post="/rules/test"', tpl)
        self.assertIn('name="sample"', tpl)
        self.assertIn('name="rule_template"', tpl)

        self.assertIn('action="/rules/{{ rule.rule_id }}/delete"', tpl)
        self.assertIn('hx-post="/rules/{{ rule.rule_id }}/delete"', tpl)


if __name__ == "__main__":
    unittest.main()
