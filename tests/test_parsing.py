import unittest

from bindery.models import book_from_dict, book_to_dict
from bindery.parsing import parse_book


class ParseBookTests(unittest.TestCase):
    def test_parse_metadata_and_chapters(self) -> None:
        text = """书名：测试书
作者：张三
内容简介：这是简介

第一章 起始
这是第一段。

第二章 继续
这是第二段。"""
        book = parse_book(text, "source")
        self.assertEqual(book.title, "测试书")
        self.assertEqual(book.author, "张三")
        self.assertEqual(book.intro, "这是简介")
        self.assertEqual(len(book.root_chapters), 2)
        self.assertEqual(book.root_chapters[0].title, "第一章 起始")
        self.assertIn("这是第一段。", book.root_chapters[0].lines)

    def test_parse_volume_structure(self) -> None:
        text = """第一卷 开端
第一章 初见
这里是内容
"""
        book = parse_book(text, "source")
        self.assertEqual(len(book.volumes), 1)
        self.assertEqual(book.volumes[0].title, "第一卷 开端")
        self.assertEqual(len(book.volumes[0].chapters), 1)
        self.assertEqual(book.volumes[0].chapters[0].title, "第一章 初见")

    def test_spine_roundtrip(self) -> None:
        text = """第一卷 开端
第一章 初见
第二章 重逢
第二卷 尾声
第三章 落幕
"""
        book = parse_book(text, "source")
        data = book_to_dict(book)
        restored = book_from_dict(data)
        original = [(type(item).__name__, item.title) for item in book.spine]
        roundtrip = [(type(item).__name__, item.title) for item in restored.spine]
        self.assertEqual(original, roundtrip)


if __name__ == "__main__":
    unittest.main()
