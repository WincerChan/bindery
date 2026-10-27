import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
import type { Preview } from "../src/server/ingest/preview";
import type { JobsPayload } from "../src/server/ingest/queries";
import { allByAttribute, allByRole, allByText, byAttribute, byName, byRole, byText, parseHtml } from "./support/queries";
let ui: typeof import("./fixtures/ingest/ui-probe");
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [solid({ ssr: true })], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/ingest/ui-probe.tsx") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(o => "output" in o ? o.output : []).find(o => o.type === "chunk" && o.isEntry); if (!entry || entry.type !== "chunk") throw new Error("Missing SSR probe");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
describe("ingest and jobs SSR", () => {
  it("offers one multi-file picker, rule/theme controls, CSS and accessible progress", () => {
    const root = parseHtml(ui.ingest()), form = byAttribute(root, "action", "/ingest");
    const picker = byName(form, "files");
    expect(allByAttribute(form, "type", "file")).toEqual([picker]);
    expect(picker.getAttribute("accept")).toBe(".txt,.epub"); expect(picker.hasAttribute("multiple")).toBe(true);
    for (const name of ["rule_template", "theme_template", "custom_css", "dedupe_mode"]) expect(byName(form, name)).toBeDefined();
    expect(byRole(byName(form, "theme_template"), "option", "保持书籍样式（仅 EPUB）").getAttribute("value")).toBe("__book__");
    const submit = byRole(form, "button", "开始入库");
    expect(submit.getAttribute("type")).toBe("submit"); expect(submit.hasAttribute("disabled")).toBe(true);
    expect(byRole(form, "status").getAttribute("aria-live")).toBe("polite");
    expect(byRole(form, "status").textContent).toContain("先选择文件");
    expect(byAttribute(form, "aria-label", "选择 TXT 或 EPUB 文件")).toBeDefined();
    for (const absent of ["预览解析", "没有可预览的内容。", "TXT 按切章规则生成 EPUB；EPUB 直接入库。", "最近任务 · 0"]) expect(root.textContent).not.toContain(absent);
    expect(allByRole(root, "main")).toHaveLength(0);
    expect(allByAttribute(root, "action", /^\/upload/)).toHaveLength(0);
    const jobs = byRole(root, "dialog", "最近任务"), trigger = byRole(root, "button", "最近任务");
    expect(jobs.getAttribute("data-state")).toBe("closed");
    expect(trigger.getAttribute("aria-controls")).toBe(jobs.id); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(byRole(jobs, "link", /^全部/)).toBeDefined();
  });
  it("escapes preview metadata, lists duplicates, tokens, keep choices and errors", () => {
    const item: Preview = { filename: '<file>.txt', format: "TXT", title: "识别书名", author: "作者", volumes: 1, chapters: 2, toc: ["第一章 <起点>"], output: "output.epub", duplicates: [{ book_id: "a".repeat(32), title: "重复书籍", author: "作者", reason: "标题" }], upload_token: "b".repeat(32) };
    const root = parseHtml(ui.previews([item])), preview = byAttribute(root, "data-preview-filename", item.filename);
    expect(preview.textContent).toContain("<file>.txt"); expect(preview.textContent).toContain("第一章 <起点>");
    expect(preview.getElementsByTagName("file").length).toBe(0); expect(preview.getElementsByTagName("起点").length).toBe(0);
    expect(preview.getAttribute("data-preview-format")).toBe("TXT"); expect(preview.getAttribute("data-preview-title")).toBe("识别书名"); expect(preview.getAttribute("data-duplicate-hit")).toBe("1");
    expect(byName(preview, "upload_tokens").getAttribute("value")).toBe(item.upload_token);
    expect(byRole(preview, "checkbox", "仍然新建一本")).toBe(byName(preview, "dedupe_keep_tokens"));
    expect(byRole(preview, "button", "目录前 10 条")).toBeDefined(); expect(root.textContent).not.toContain("落库路径");
    expect(parseHtml(ui.previews([])).textContent).not.toContain("没有可预览的内容。");
    const failed = parseHtml(ui.previews([{ ...item, error: "错误" }]));
    expect(byRole(failed, "alert").textContent).toBe("错误");
    for (const name of ["upload_tokens", "dedupe_keep_tokens"]) expect(allByAttribute(failed, "name", name)).toHaveLength(0);
  });
  it("shows tab counts, job identity, retry forms, logs, cleanup and pagination", () => {
    const data: JobsPayload = { jobs: [{ id: "job", book_id: "a".repeat(32), book_title: "书名 <&>", book_author: "作者", can_open_book: true, action_label: "重新生成", action: "regenerate", status: "failed", stage: "失败", rule_template: "default", message: "转换失败", log: "<script>bad</script>", created_at: "2026", updated_at: "2026" }], tabs: [{ key: "failed", label: "失败", count: 13 }], active_tab: "failed", page: 1, total_pages: 2, total_jobs: 13, invalid_job_count: 2 };
    const root = parseHtml(ui.jobs(data));
    expect(byText(root, "任务 ID：job")).toBeDefined();
    expect(byRole(byRole(root, "navigation", "任务分组"), "link", "失败 · 13").getAttribute("href")).toBe("/ingest?jobs_tab=failed&jobs_page=1#jobs");
    expect(byRole(byAttribute(root, "action", "/jobs/job/retry"), "button", "一键重试")).toBeDefined();
    expect(byAttribute(root, "action", "/jobs/cleanup-invalid")).toBeDefined();
    expect(byRole(root, "link", "打开产物").getAttribute("href")).toBe(`/book/${"a".repeat(32)}`);
    expect(byText(root, "<script>bad</script>")).toBeDefined(); expect(root.getElementsByTagName("script").length).toBe(0);
    expect(byRole(root, "button", "展开详细日志")).toBeDefined();
    const pager = byRole(root, "navigation", "分页");
    expect(pager.textContent).toContain("1–1 / 共"); expect(byAttribute(pager, "data-pagination-total").textContent).toBe("13");
    expect(byRole(pager, "link", "下一页").getAttribute("href")).toBe("/ingest?jobs_tab=failed&jobs_page=2#jobs");
    expect(root.textContent).not.toContain("当前分组共"); expect(allByRole(root, "main")).toHaveLength(0);
    const duplicate = parseHtml(ui.jobs({ ...data, jobs: [{ ...data.jobs[0]!, status: "success", stage: "完成", message: "完成", log: null }] }));
    // A message equal to its stage is shown only once, not repeated as a separate message.
    expect(allByText(duplicate, /^完成(?: · default)?$/)).toHaveLength(1);
    expect(byText(root, "转换失败")).toBeDefined();
  });
});
