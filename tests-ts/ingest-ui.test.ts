import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { binderyIcons } from "../scripts/vite-icons";
import solid from "vite-plugin-solid";
import { mutationPlugin } from "./support/mutation-plugin";
import { resolve } from "node:path";
import { solidOptions } from "../scripts/solid-options";
import { clientDocument } from "./support/client-dom";
import type { Preview } from "../src/server/ingest/preview";
import type { JobsPayload } from "../src/server/ingest/queries";
import { allByAttribute, allByRole, allByText, byAttribute, byName, byRole, byText, parseHtml } from "./support/queries";
let ui: typeof import("./fixtures/ingest/ui-probe"), client: typeof ui;
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [...binderyIcons(), mutationPlugin(), solid({ ssr: true })], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/ingest/ui-probe.tsx") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(o => "output" in o ? o.output : []).find(o => o.type === "chunk" && o.isEntry); if (!entry || entry.type !== "chunk") throw new Error("Missing SSR probe");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
  const built = await build({ configFile: false, logLevel: "silent", plugins: [...binderyIcons(), mutationPlugin(), solid({ ...solidOptions, dev: false, hot: false })], resolve: { conditions: ["browser", "production"] }, define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, minify: false, lib: { entry: resolve("tests-ts/fixtures/ingest/ui-probe.tsx"), formats: ["es"] } } });
  const chunk = (Array.isArray(built) ? built : [built]).flatMap(o => "output" in o ? o.output : []).find(o => o.type === "chunk" && o.isEntry);
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing client probe");
  client = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64"));
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
    expect(submit.getAttribute("type")).toBe("submit"); expect(submit.hasAttribute("disabled")).toBe(false); // Native multipart submission works before hydration.
    expect(byRole(form, "status").getAttribute("aria-live")).toBe("polite");
    expect(byRole(form, "status").textContent).toContain("先选择文件");
    expect(byAttribute(form, "aria-label", "选择 TXT 或 EPUB 文件")).toBeDefined();
    for (const absent of ["预览解析", "没有可预览的内容。", "TXT 按切章规则生成 EPUB；EPUB 直接入库。", "最近任务 · 0"]) expect(root.textContent).not.toContain(absent);
    expect(byRole(root, "heading", "把书放进来。")).toBeDefined();
    expect(byRole(root, "button", "添加书籍")).toBeDefined();
    expect(byRole(root, "combobox", "切章")).toBeDefined();
    expect(byRole(root, "combobox", "主题")).toBeDefined();
    expect(byRole(root, "button", "追加本批 CSS").getAttribute("aria-expanded")).toBe("false");
    expect(allByRole(root, "main")).toHaveLength(0);
    expect(allByAttribute(root, "action", /^\/upload/)).toHaveLength(0);
    const jobs = byRole(root, "dialog", "最近任务"), trigger = byRole(root, "button", "最近任务");
    expect(jobs.getAttribute("data-state")).toBe("closed");
    expect(trigger.getAttribute("aria-controls")).toBe(jobs.id); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(byRole(jobs, "link", /^全部/)).toBeDefined();
    expect(allByRole(form, "dialog", "最近任务")).toHaveLength(0); // Retry/cleanup forms must never nest inside multipart upload.
  });
  it("escapes preview metadata, lists duplicates, tokens, keep choices and errors", () => {
    const item: Preview = { filename: '<file>.txt', format: "TXT", title: "识别书名", author: "作者", volumes: 1, chapters: 2, toc: ["第一章 <起点>"], output: "output.epub", duplicates: [{ book_id: "a".repeat(32), title: "重复书籍", author: "作者", reason: "标题" }], upload_token: "b".repeat(32) };
    const root = parseHtml(ui.previews([item])), preview = byAttribute(root, "data-preview-filename", item.filename);
    expect(preview.textContent).toContain("<file>.txt"); expect(preview.textContent).toContain("第一章 <起点>");
    expect(preview.getElementsByTagName("file").length).toBe(0); expect(preview.getElementsByTagName("起点").length).toBe(0);
    const dialog = byRole(preview, "dialog", "识别书名");
    expect(dialog.getAttribute("data-state")).toBe("closed");
    expect(allByRole(preview, "button", "查看《识别书名》解析结果（疑似重复，默认归入已有书籍）")).toHaveLength(2);
    expect(byRole(dialog, "link", "《重复书籍》（作者）").getAttribute("href")).toBe(`/book/${"a".repeat(32)}`);
    expect(preview.getAttribute("data-preview-format")).toBe("TXT"); expect(preview.getAttribute("data-preview-title")).toBe("识别书名"); expect(preview.getAttribute("data-duplicate-hit")).toBe("1");
    expect(byName(preview, "upload_tokens").getAttribute("value")).toBe(item.upload_token);
    expect(byRole(preview, "group", "重复书籍的处理方式")).toBeDefined();
    expect(byRole(preview, "button", "归入已有").getAttribute("aria-pressed")).toBe("true");
    expect(byRole(preview, "button", "新建一本").getAttribute("aria-pressed")).toBe("false");
    expect(allByAttribute(preview, "name", "dedupe_keep_tokens")).toHaveLength(0);
    expect(byRole(preview, "heading", "目录")).toBeDefined(); expect(root.textContent).not.toContain("落库路径");
    expect(parseHtml(ui.previews([])).textContent).not.toContain("没有可预览的内容。");
    const failed = parseHtml(ui.previews([{ ...item, error: "错误" }]));
    expect(byRole(failed, "alert").textContent).toBe("错误");
    for (const name of ["upload_tokens", "dedupe_keep_tokens"]) expect(allByAttribute(failed, "name", name)).toHaveLength(0);
  });
  it("keeps the chapter excerpt compact and omits nonexistent TXT volumes", () => {
    const item: Preview = { filename: "sample.txt", format: "TXT", title: "书名", author: "作者", volumes: 0, chapters: 12, toc: Array.from({ length: 12 }, (_, index) => `第${index + 1}章`), duplicates: [], output: "sample.epub", upload_token: null };
    const dialog = byRole(parseHtml(ui.previews([item])), "dialog", "书名");
    expect(allByRole(dialog, "listitem").map(item => item.textContent)).toEqual(["第1章", "第2章", "第3章", "第4章", "第5章", "第6章", "…… 共 12 章"]);
    expect(dialog.textContent).toContain("作者 · 12 章"); expect(dialog.textContent).not.toContain("0 卷");
    expect(byRole(parseHtml(ui.previews([{ ...item, volumes: 2 }])), "dialog", "书名").textContent).toContain("作者 · 2 卷 · 12 章");
    const short = byRole(parseHtml(ui.previews([{ ...item, chapters: 2, toc: ["第一章", "第二章"] }])), "dialog", "书名");
    expect(allByRole(short, "listitem")).toHaveLength(2); expect(short.textContent).not.toContain("……");
  });
  it("shows tab counts, job identity, retry forms, logs, cleanup and pagination", () => {
    const data: JobsPayload = { jobs: [{ id: "job", book_id: "a".repeat(32), book_title: "书名 <&>", book_author: "作者", can_open_book: true, action_label: "重新生成", action: "regenerate", status: "failed", stage: "失败", rule_template: "default", message: "转换失败", log: "<script>bad</script>", created_at: "2026", updated_at: "2026" }], tabs: [{ key: "failed", label: "失败", count: 13 }], active_tab: "failed", page: 1, total_pages: 2, total_jobs: 13, invalid_job_count: 2 };
    const root = parseHtml(ui.jobs(data));
    expect(byText(root, "任务 ID：job")).toBeDefined();
    expect(byRole(byRole(root, "navigation", "任务分组"), "link", "失败").getAttribute("href")).toBe("/ingest?jobs_tab=failed&jobs_page=1#jobs");
    expect(byRole(byAttribute(root, "action", "/jobs/job/retry"), "button", "重试《书名 <&>》")).toBeDefined();
    expect(byAttribute(root, "action", "/jobs/cleanup-invalid")).toBeDefined();
    expect(byRole(root, "link", "打开产物").getAttribute("href")).toBe(`/book/${"a".repeat(32)}`);
    expect(byText(root, "<script>bad</script>")).toBeDefined(); expect(root.getElementsByTagName("script").length).toBe(0);
    expect(byRole(root, "button", "展开详细日志")).toBeDefined();
    const pager = byRole(root, "navigation", "分页");
    expect(pager.textContent).toContain("1–1 项 · 共"); expect(byAttribute(pager, "data-pagination-total").textContent).toBe("13");
    expect(byRole(pager, "link", "下一页").getAttribute("href")).toBe("/ingest?jobs_tab=failed&jobs_page=2#jobs");
    expect(root.textContent).not.toContain("当前分组共"); expect(allByRole(root, "main")).toHaveLength(0);
    const duplicate = parseHtml(ui.jobs({ ...data, jobs: [{ ...data.jobs[0]!, status: "success", stage: "完成", message: "完成", log: null }] }));
    // A message equal to its stage is shown only once, not repeated as a separate message.
    expect(allByText(duplicate, /^完成(?: · default)?$/)).toHaveLength(1);
    expect(byText(root, "转换失败")).toBeDefined();
    expect(byRole(root, "dialog", "清空失效历史任务？").getAttribute("data-state")).toBe("closed");
  });
});

function firstPage(initial = { token: "first-token", title: "真实书名", rule: "default", theme: "default" }) {
  const document = clientDocument(); document.addEventListener = vi.fn(); document.removeEventListener = vi.fn();
  vi.stubGlobal("document", document); vi.stubGlobal("self", globalThis);
  const node = document.createElement("div"); document.documentElement.appendChild(node);
  const mounted = client.mountFirstPage(node, initial); disposers.push(mounted.dispose);
  return { ...mounted, node, initial };
}
const result = (section: string) => ({ section_title: section, volume_title: "第一卷", html: `<html><body><h1>${section}</h1><p>真实正文</p></body></html>` });

describe("staged first-page preview", () => {
  it("debounces selection changes, POSTs real tokens and isolates the returned document", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => result("第一章") }); vi.stubGlobal("fetch", fetch);
    const mounted = firstPage();
    expect(byRole(mounted.node, "status").textContent).toContain("正在排出第一页");
    await vi.advanceTimersByTimeAsync(249); expect(fetch).not.toHaveBeenCalled();
    mounted.update({ ...mounted.initial, theme: "paper" });
    await vi.advanceTimersByTimeAsync(250); mounted.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("/ingest/first-page");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" } });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ upload_token: "first-token", rule_id: "default", theme_id: "paper" });
    const frame = byAttribute(mounted.node, "title", "《真实书名》第一页");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toBe(result("第一章").html);
    expect(byText(mounted.node, "第一卷")).toBeDefined(); expect(byText(mounted.node, "第一章")).toBeDefined();
    expect(mounted.node.getElementsByTagName("h1")).toHaveLength(0); // Book HTML is not injected into the app.
    mounted.update({ ...mounted.initial, rule: "novel", theme: "paper" });
    await vi.advanceTimersByTimeAsync(250); mounted.flush();
    expect(JSON.parse(fetch.mock.calls[1]![1].body).rule_id).toBe("novel");
  });

  it("cancels old requests and ignores late responses after selection changes or removal", async () => {
    vi.useFakeTimers();
    const pending: { resolve: (value: unknown) => void; signal: AbortSignal }[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise(resolve => pending.push({ resolve, signal: init.signal as AbortSignal }))); vi.stubGlobal("fetch", fetch);
    const mounted = firstPage();
    await vi.advanceTimersByTimeAsync(250);
    mounted.update({ ...mounted.initial, theme: "new-theme" });
    expect(pending[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    pending[1]!.resolve({ ok: true, json: async () => result("新排版") }); await vi.advanceTimersByTimeAsync(0); mounted.flush();
    pending[0]!.resolve({ ok: true, json: async () => result("过期排版") }); await vi.advanceTimersByTimeAsync(0); mounted.flush();
    expect(byAttribute(mounted.node, "title", "《真实书名》第一页").getAttribute("srcdoc")).toContain("新排版");
    expect(mounted.node.textContent).not.toContain("过期排版");
    mounted.update({ ...mounted.initial, token: "next-token" }); await vi.advanceTimersByTimeAsync(250);
    mounted.update({ ...mounted.initial, token: "" }); expect(pending[2]!.signal.aborted).toBe(true);
    pending[2]!.resolve({ ok: true, json: async () => result("已移除") }); await vi.advanceTimersByTimeAsync(0); mounted.flush();
    expect(mounted.node.getElementsByTagName("iframe")).toHaveLength(0);
    expect(byRole(mounted.node, "status").textContent).toContain("解析完成后");
    mounted.update(mounted.initial); await vi.advanceTimersByTimeAsync(250);
    mounted.dispose(); expect(pending[3]!.signal.aborted).toBe(true);
  });

  it.each(["api", "http", "network", "login"])("shows a graceful %s error and recovers on a new selection", async kind => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => {
      if (kind === "network") throw new Error("网络暂不可用");
      return { ok: kind !== "http", redirected: kind === "login", json: async () => ({ error: "未找到可预览的正文章节" }) };
    }); vi.stubGlobal("fetch", fetch);
    const mounted = firstPage(); await vi.advanceTimersByTimeAsync(250); mounted.flush();
    expect(byRole(mounted.node, "status").textContent).toContain("不影响已解析书籍入库");
    expect(mounted.node.getElementsByTagName("iframe")).toHaveLength(0);
    fetch.mockResolvedValue({ ok: true, json: async () => result("恢复后的正文") });
    mounted.update({ ...mounted.initial, theme: "retry-theme" }); await vi.advanceTimersByTimeAsync(250); mounted.flush();
    expect(byAttribute(mounted.node, "title", "《真实书名》第一页").getAttribute("sandbox")).toBe("");
    expect(byText(mounted.node, "恢复后的正文")).toBeDefined();
  });
});
