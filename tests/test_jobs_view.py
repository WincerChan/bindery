import unittest

from bindery.models import Job, Metadata
from bindery.web import _invalid_job_ids, _job_action_label, _job_view


class JobsViewTests(unittest.TestCase):
    def test_job_action_label_maps_known_actions(self) -> None:
        self.assertEqual(_job_action_label("upload"), "上传并转换")
        self.assertEqual(_job_action_label("upload-epub"), "EPUB 入库")
        self.assertEqual(_job_action_label("regenerate"), "重新生成")
        self.assertEqual(_job_action_label("retry"), "重试生成")
        self.assertEqual(_job_action_label("ingest"), "入库检查")
        self.assertEqual(_job_action_label("custom-action"), "custom-action")

    def test_job_view_enriches_book_title_and_author(self) -> None:
        job = Job(
            id="job-1",
            book_id="book-1",
            action="upload",
            status="running",
            stage="预处理",
            message=None,
            log=None,
            rule_template="default",
            created_at="2026-02-06T08:00:00+00:00",
            updated_at="2026-02-06T08:00:00+00:00",
        )
        meta = Metadata(
            book_id="book-1",
            title="示例书",
            author="示例作者",
            language="zh-CN",
            description=None,
            created_at="",
            updated_at="",
        )

        view = _job_view(job, {"book-1": meta})
        self.assertEqual(view["book_title"], "示例书")
        self.assertEqual(view["book_author"], "示例作者")
        self.assertTrue(view["can_open_book"])
        self.assertEqual(view["action_label"], "上传并转换")

    def test_job_view_handles_missing_or_archived_book(self) -> None:
        job = Job(
            id="job-2",
            book_id="book-2",
            action="retry",
            status="failed",
            stage="失败",
            message="转换失败",
            log="trace",
            rule_template="default",
            created_at="2026-02-06T08:00:00+00:00",
            updated_at="2026-02-06T08:00:00+00:00",
        )
        missing_view = _job_view(job, {})
        self.assertEqual(missing_view["book_title"], "未关联书籍")
        self.assertEqual(missing_view["book_author"], "未知")
        self.assertFalse(missing_view["can_open_book"])

        meta = Metadata(
            book_id="book-2",
            title="已归档书籍",
            author=None,
            language="zh-CN",
            description=None,
            archived=True,
            created_at="",
            updated_at="",
        )
        archived_view = _job_view(job, {"book-2": meta})
        self.assertEqual(archived_view["book_title"], "已归档书籍")
        self.assertEqual(archived_view["book_author"], "未知")
        self.assertFalse(archived_view["can_open_book"])

    def test_invalid_job_ids_detects_unlinked_jobs(self) -> None:
        valid_job = Job(
            id="job-valid",
            book_id="book-1",
            action="upload",
            status="success",
            stage="完成",
            message=None,
            log=None,
            rule_template="default",
            created_at="2026-02-06T08:00:00+00:00",
            updated_at="2026-02-06T08:00:00+00:00",
        )
        missing_book_job = Job(
            id="job-missing",
            book_id="book-x",
            action="upload",
            status="success",
            stage="完成",
            message=None,
            log=None,
            rule_template="default",
            created_at="2026-02-06T08:00:00+00:00",
            updated_at="2026-02-06T08:00:00+00:00",
        )
        no_book_job = Job(
            id="job-none",
            book_id=None,
            action="ingest",
            status="failed",
            stage="失败",
            message="空文件",
            log=None,
            rule_template="default",
            created_at="2026-02-06T08:00:00+00:00",
            updated_at="2026-02-06T08:00:00+00:00",
        )
        meta = Metadata(
            book_id="book-1",
            title="示例书",
            author="示例作者",
            language="zh-CN",
            description=None,
            created_at="",
            updated_at="",
        )
        stale = _invalid_job_ids([valid_job, missing_book_job, no_book_job], {"book-1": meta})
        self.assertEqual(stale, ["job-missing", "job-none"])


if __name__ == "__main__":
    unittest.main()
