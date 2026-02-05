import unittest
from pathlib import Path


class RulesUiTests(unittest.TestCase):
    def test_rules_template_has_actions_and_rule_details(self) -> None:
        root = Path(__file__).resolve().parent.parent
        tpl = (root / "templates" / "rules.html").read_text(encoding="utf-8")

        # Sidebar actions
        self.assertIn("新增", tpl)
        self.assertIn("删除", tpl)

        # Rule detail panel
        self.assertIn("解析规则", tpl)
        self.assertIn("章节正则", tpl)
        self.assertIn("卷/部正则", tpl)
        self.assertIn("特殊标题", tpl)
        self.assertIn("候选过滤正则", tpl)


if __name__ == "__main__":
    unittest.main()

