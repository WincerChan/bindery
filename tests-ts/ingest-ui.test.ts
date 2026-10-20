import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
import type { Preview } from "../src/server/ingest/preview";
import type { JobsPayload } from "../src/server/ingest/queries";
let ui: typeof import("./fixtures/ingest/ui-probe");
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [solid({ ssr: true })], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/ingest/ui-probe.tsx") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(o => "output" in o ? o.output : []).find(o => o.type === "chunk" && o.isEntry); if (!entry || entry.type !== "chunk") throw new Error("Missing SSR probe");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
describe("ingest and jobs SSR", () => {
  it("offers one multi-file picker, rule/theme controls, CSS and accessible progress", () => {
    const html = ui.ingest(); expect(html).toContain('action="/ingest"'); expect(html.match(/type="file"/g)).toHaveLength(1); expect(html).toContain('accept=".txt,.epub"'); expect(html).toContain('multiple'); expect(html).toContain('name="rule_template"'); expect(html).toContain('name="theme_template"'); expect(html).toContain('value="__book__"'); expect(html).toContain('name="custom_css"'); expect(html).toContain('name="dedupe_mode"'); expect(html).toContain('type="submit"'); expect(html).toContain('aria-live="polite"'); expect(html).not.toContain("预览解析"); expect(html).not.toContain("没有可预览的内容。"); expect(html).toContain("TXT 按切章规则生成 EPUB；EPUB 直接入库。"); expect(html).toContain("先选择文件"); expect(html).toMatch(/<button[^>]*disabled[^>]*type="submit"[^>]*>开始入库<\/button>/); expect(html).toContain('class="ingest-dropzone  "'); expect(html).not.toContain('<main'); expect(html).not.toContain("/upload"); expect(html).toMatch(/<dialog[^>]*id="jobs"[^>]*dialog-sheet[^>]*data-state="closed"/); expect(html).not.toMatch(/<section[^>]*id="jobs"/); expect(html).toContain('aria-controls="jobs" aria-expanded="false"'); expect(html).toContain("最近任务"); expect(html).not.toContain("最近任务 · 0"); expect(html).toContain("全部");
  });
  it("escapes preview metadata, lists duplicates, tokens, keep choices and errors", () => {
    const item: Preview = { filename: '<file>.txt', format: "TXT", title: "识别书名", author: "作者", volumes: 1, chapters: 2, toc: ["第一章 <起点>"], output: "output.epub", duplicates: [{ book_id: "a".repeat(32), title: "重复书籍", author: "作者", reason: "标题" }], upload_token: "b".repeat(32) };
    const html = ui.previews([item]); expect(html).toContain("&lt;file>.txt"); expect(html).toContain('data-preview-format="TXT"'); expect(html).toContain('data-preview-title="识别书名"'); expect(html).toContain('data-duplicate-hit="1"'); expect(html).toContain('name="upload_tokens"'); expect(html).toContain('name="dedupe_keep_tokens"'); expect(html).toContain("仍然新建一本"); expect(html).toContain("目录前 10 条"); expect(html).not.toContain("落库路径"); expect(ui.previews([])).not.toContain("没有可预览的内容。"); const failed = ui.previews([{ ...item, error: "错误" }]); expect(failed).toContain('role="alert"'); expect(failed).toContain("错误"); expect(failed).not.toContain('name="upload_tokens"'); expect(failed).not.toContain('name="dedupe_keep_tokens"');
  });
  it("shows tab counts, list rows, retry forms, logs, cleanup and pagination", () => {
    const data: JobsPayload = { jobs: [{ id: "job", book_id: "a".repeat(32), book_title: "书名 <&>", book_author: "作者", can_open_book: true, action_label: "重新生成", action: "regenerate", status: "failed", stage: "失败", rule_template: "default", message: "转换失败", log: "<script>bad</script>", created_at: "2026", updated_at: "2026" }], tabs: [{ key: "failed", label: "失败", count: 13 }], active_tab: "failed", page: 1, total_pages: 2, total_jobs: 13, invalid_job_count: 2 };
    const html = ui.jobs(data); expect(html).toContain('id="jobs-section"'); expect(html).toContain('href="/ingest?jobs_tab=failed&amp;jobs_page=1#jobs"'); expect(html).toContain('action="/jobs/job/retry"'); expect(html).toContain('action="/jobs/cleanup-invalid"'); expect(html).toContain("一键重试"); expect(html).toContain("打开产物"); expect(html).toContain("&lt;script>bad&lt;/script>"); expect(html).toContain("展开详细日志"); expect(html).toContain("下一页"); expect(html).toContain('href="/ingest?jobs_tab=failed&amp;jobs_page=2#jobs"'); expect(html).not.toContain('<main');
  });
});
