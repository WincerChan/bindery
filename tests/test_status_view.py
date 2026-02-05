import unittest

from bindery.models import Metadata
from bindery.web import _status_view, _update_meta_synced


class StatusViewTests(unittest.TestCase):
    def test_update_meta_synced_sets_timestamps_in_order(self) -> None:
        meta = Metadata(
            book_id="test",
            title="t",
            author=None,
            language="zh-CN",
            description=None,
            created_at="",
            updated_at="",
        )
        meta.status = "dirty"

        _update_meta_synced(meta)

        self.assertEqual(meta.status, "synced")
        self.assertIsNotNone(meta.updated_at)
        self.assertIsNotNone(meta.epub_updated_at)
        self.assertEqual(meta.updated_at, meta.epub_updated_at)

        label, cls = _status_view(meta)
        self.assertEqual(cls, "ok")
        self.assertEqual(label, "已写回元数据")


if __name__ == "__main__":
    unittest.main()

