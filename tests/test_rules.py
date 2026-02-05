import unittest

from bindery.rules import get_rule, load_rule_templates
from bindery.parsing import parse_book


class RulesTests(unittest.TestCase):
    def test_load_rules(self) -> None:
        rules = load_rule_templates()
        self.assertTrue(rules)
        self.assertTrue(any(rule.rule_id == "default" for rule in rules))

    def test_parse_with_rule(self) -> None:
        rule = get_rule("default")
        text = """第一章 起始\n内容\n"""
        book = parse_book(text, "source", rule.rules)
        self.assertEqual(len(book.root_chapters), 1)


if __name__ == "__main__":
    unittest.main()
