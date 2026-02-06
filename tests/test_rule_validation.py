import unittest

from bindery.rules import RuleTemplateError, validate_rule_template_json


class RuleValidationTests(unittest.TestCase):
    def test_rejects_invalid_json(self) -> None:
        with self.assertRaises(RuleTemplateError):
            validate_rule_template_json("default", "{not json")

    def test_rejects_id_mismatch(self) -> None:
        raw = """{
  "id": "other",
  "name": "x",
  "version": "1",
  "chapter_patterns": [],
  "volume_patterns": [],
  "special_headings": [],
  "heading_max_len": 40,
  "heading_max_commas": 1,
  "skip_candidate_re": "x"
}"""
        with self.assertRaises(RuleTemplateError):
            validate_rule_template_json("default", raw)

    def test_rejects_invalid_regex(self) -> None:
        raw = """{
  "id": "default",
  "name": "x",
  "version": "1",
  "chapter_patterns": ["("],
  "volume_patterns": [],
  "special_headings": [],
  "heading_max_len": 40,
  "heading_max_commas": 1,
  "skip_candidate_re": "x"
}"""
        with self.assertRaises(RuleTemplateError):
            validate_rule_template_json("default", raw)

    def test_normalizes_and_keeps_required_fields(self) -> None:
        raw = """{
  "id": "default",
  "name": "Name",
  "chapter_patterns": ["^A$"],
  "volume_patterns": [],
  "special_headings": [],
  "heading_max_len": "40",
  "heading_max_commas": "1",
  "skip_candidate_re": "x"
}"""
        data = validate_rule_template_json("default", raw)
        self.assertEqual(data["id"], "default")
        self.assertEqual(data["name"], "Name")
        self.assertEqual(data["heading_max_len"], 40)
        self.assertEqual(data["heading_max_commas"], 1)
        self.assertEqual(data["chapter_patterns"], ["^A$"])


if __name__ == "__main__":
    unittest.main()

