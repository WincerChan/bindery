import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { mutationPlugin } from "./support/mutation-plugin";
import { resolve } from "node:path";
import type { EditorData } from "../src/server/catalog/templates";
import type { TrackerItem, TrackerPageData } from "../src/server/catalog/tracker";
import { formatCssText, themePreviewDocument } from "../src/features/catalog/client";

let ui: typeof import("./fixtures/catalog/ui-probe");
const editor: EditorData = { id: "default", name: "默认规则", version: "1", description: "默认切章规则", raw: '{"name":"<script>"}', saved: false, error: null };
const wish: TrackerItem = { id: "a".repeat(32), title: "书名<script>", author: "作者", library_book_id: "b".repeat(32), rating: 4, read: false, read_status: "reading", tags: ["科幻"], tags_text: "科幻", comment: "短评", book_status: "completed", created_at: "2026-04-01T10:00:00+00:00", updated_at: "2026-04-01T10:00:00+00:00", updated_at_display: "2026-04-01 10:00", read_status_label: "在读", book_status_label: "已完结", exists_in_library: true, exists_label: "已存在" };
const tracker: TrackerPageData = { filters: { q: "科幻", read_filter: "all", library_filter: "all", book_status_filter: "all" }, stats: { total: 25, filtered: 25, read: 0, reading: 1, unread: 24, in_library: 1, out_library: 24 }, wishes: [wish], page: 2, total_pages: 2, current_url: "/tracker?q=科幻&page=2", export_url: "/tracker/export?q=科幻", duplicate_notice: wish };
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [mutationPlugin(), solid({ ssr: true })], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/catalog/ui-probe.tsx") } });
  const outputs = Array.isArray(result) ? result : [result], entry = outputs.flatMap(o => "output" in o ? o.output : []).find(o => o.type === "chunk" && o.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing catalog UI bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
describe("catalog UI SSR and accessible controls", () => {
  it("renders rule editing, saved-template testing, JSON formatting and protected default deletion", () => {
    const html = ui.editor(editor, "rules");
    for (const expected of ['id="rule-editor"', 'action="/rules/default/editor"', 'name="config_json"', "格式化", 'action="/rules/test"', 'name="sample"', 'name="rule_template"', "用已保存的规则，输入后自动运行", "粘贴一段文本后", "disabled"]) expect(html).toContain(expected); expect(html).not.toContain('action="/rules/default/delete"');
    expect(html).toContain("&lt;script>"); expect(html).not.toContain("<script>");
    expect(html).toMatch(/<label[^>]*for=/); expect(html).toMatch(/<button[^>]*type="submit"/);
  });
  it("renders theme formatting and an isolated preview with a descriptive title", () => {
    const html = ui.editor({ ...editor, raw: "p{color:red}" }, "themes");
    for (const expected of ['id="theme-editor"', 'action="/themes/default/editor"', 'name="css"', "格式化", "主题 CSS 实时预览", "srcdoc=", "Content-Security-Policy"]) expect(html).toContain(expected);
    expect(html).toMatch(/<iframe[^>]*\ssandbox(?:="")?(?:\s|>)/);
    expect(html).not.toContain("<script");
  });
  it("renders template navigation, creation and the shared batch-rebuild form", () => {
    const data = { rules: [{ ...editor, book_count: 0, archived_count: 0 }], themes: [{ ...editor, name: "默认样式", book_count: 0, archived_count: 0 }], tab: "parsing", ruleId: "default", themeId: "default", error: "引用错误", editor };
    const html = ui.rules(data), themeHtml = ui.rules({ ...data, tab: "themes" });
    for (const expected of ['action="/rules/new"', 'action="/books/regenerate"', 'name="scope" value="parsing"', 'name="template_id" value="default"', 'aria-current="page"', "引用错误", "切章规则", "主题"]) expect(html).toContain(expected);
    expect(themeHtml).toContain('action="/themes/new"'); expect(themeHtml).toContain('name="scope" value="themes"');
  });
  it("renders escaped TOC counts and empty results", () => {
    expect(ui.preview(null)).toContain("粘贴一段文本后");
    const html = ui.preview({ volumes: 1, chapters: 2, toc: ["<img src=x>", "第二章"] }); expect(html).toContain("识别出"); expect(html).toContain("卷 · "); expect(html).toContain("&lt;img"); expect(html).toContain("第二章");
  });
  it("renders tracker filtering, export, detail return URL, edit/delete and pagination", () => {
    const html = ui.tracker(tracker);
    for (const expected of ['action="/tracker"', 'method="get"', 'name="q"', 'name="read_filter"', 'name="library_filter"', 'name="book_status_filter"', "导出 CSV", "添加书籍", "编辑", 'class="catalog-tracker-book"', "return_to=%2Ftracker%3Fq%3D", "更新", "上一页", 'aria-label="分页"', 'action="/tracker/' + wish.id + '/delete"', "点此前往编辑该条目。"]) expect(html).toContain(expected);
    expect(html).toContain("书名&lt;script>"); expect(html).not.toContain("<script>");
    expect(ui.tracker({ ...tracker, wishes: [] })).toContain("没有符合筛选条件的书籍。");
  });
  it("renders all tracker form fields, completed/unread defaults and immutable linked identity", () => {
    const html = ui.form();
    for (const field of ["title", "author", "tags", "rating", "comment", "library_book_id", "read_status", "book_status", "next"]) expect(html).toContain(`name="${field}"`);
    for (const label of ["书名", "作者", "状态", "评分", "阅读状态", "未读", "在读", "已读", "更新中", "已断更", "已完结"]) expect(html).toContain(label);
    expect(html).toContain('value="completed" selected'); expect(html).toContain('value="unread" selected');
    const linked = ui.form(wish); expect(linked).toContain('action="/tracker/' + wish.id + '/update"'); expect(linked).toContain("readonly"); expect(linked).toContain("已入库条目的书名/作者由书库元数据维护");
  });
});
describe("theme formatting and preview safety", () => {
  it("formats CSS while preserving strings, comments, nesting and semicolons in functions", () => {
    const raw = '@media print{p{content:"a;{b}";background:url(data:image/svg+xml;base64,abc);color:red;}}/* keep { } */';
    const formatted = formatCssText(raw);
    expect(formatted).toContain('content:"a;{b}";'); expect(formatted).toContain("url(data:image/svg+xml;base64,abc)"); expect(formatted).toContain("/* keep { } */"); expect(formatted).toContain("\n  p {\n"); expect(formatCssText(formatted)).toBe(formatted);
  });
  it("blocks external resources and style/script escape sequences in the preview document", () => {
    const html = themePreviewDocument('p{} </StYlE><script>alert(1)</script><style>');
    expect(html).toContain("default-src 'none'"); expect(html).toContain("form-action 'none'"); expect(html).not.toMatch(/<\/style><script/i); expect(html).toContain('<html lang="zh-CN">');
  });
});
