import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { mutationPlugin } from "./support/mutation-plugin";
import { resolve } from "node:path";
import type { EditorData } from "../src/server/catalog/templates";
import type { TrackerItem, TrackerPageData } from "../src/server/catalog/tracker";
import { formatCssText, themePreviewDocument } from "../src/features/catalog/client";

import { allByAttribute, allByRole, byAttribute, byLabel, byName, byRole, byText, parseHtml } from "./support/queries";
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
    const root = parseHtml(html);
    for (const action of ["/rules/default/editor", "/rules/test"]) expect(byAttribute(root, "action", action)).toBeDefined();
    expect(byName(root, "rule_template").getAttribute("value")).toBe("default");
    expect(byRole(root, "button", "格式化")).toBeDefined();
    for (const copy of ["用已保存的规则，输入后自动运行", "粘贴一段文本后"]) expect(root.textContent).toContain(copy);
    expect(allByAttribute(root, "action", "/rules/default/delete")).toHaveLength(0);
    expect(byName(root, "config_json").textContent).toContain("<script>"); expect(root.getElementsByTagName("script").length).toBe(0);
    expect(byLabel(root, "规则 JSON")).toBe(byName(root, "config_json"));
    expect(byLabel(root, "试切")).toBe(byName(root, "sample"));
    expect(byRole(root, "button", "保存").getAttribute("type")).toBe("submit");
    expect(byRole(root, "button", "保存").hasAttribute("disabled")).toBe(true);
  });
  it("renders theme formatting and an isolated preview with a descriptive title", () => {
    const html = ui.editor({ ...editor, raw: "p{color:red}" }, "themes");
    const root = parseHtml(html);
    expect(byName(byAttribute(root, "action", "/themes/default/editor"), "css")).toBeDefined();
    expect(byRole(root, "button", "格式化")).toBeDefined();
    const frame = byAttribute(root, "title", "主题 CSS 实时预览");
    expect(frame.hasAttribute("sandbox")).toBe(true); expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(html).not.toContain("<script");
  });
  it("renders template navigation, creation and the shared batch-rebuild form", () => {
    const data = { rules: [{ ...editor, book_count: 0, archived_count: 0 }], themes: [{ ...editor, name: "默认样式", book_count: 0, archived_count: 0 }], tab: "parsing", ruleId: "default", themeId: "default", error: "引用错误", editor };
    const html = ui.rules(data), themeHtml = ui.rules({ ...data, tab: "themes" });
    const root = parseHtml(html), themes = parseHtml(themeHtml);
    expect(byAttribute(root, "action", "/rules/new")).toBeDefined();
    const rebuild = byAttribute(root, "action", "/books/regenerate");
    expect(byName(rebuild, "scope").getAttribute("value")).toBe("parsing"); expect(byName(rebuild, "template_id").getAttribute("value")).toBe("default");
    expect(byRole(byRole(root, "navigation", "模板类型"), "link", "切章规则").getAttribute("aria-current")).toBe("page");
    expect(byRole(root, "alert").textContent).toBe("引用错误"); expect(byRole(root, "link", "主题")).toBeDefined();
    expect(byAttribute(themes, "action", "/themes/new")).toBeDefined(); expect(byName(themes, "scope").getAttribute("value")).toBe("themes");
  });
  it("renders escaped TOC counts and empty results", () => {
    expect(ui.preview(null)).toContain("粘贴一段文本后");
    const root = parseHtml(ui.preview({ volumes: 1, chapters: 2, toc: ["<img src=x>", "第二章"] }));
    expect(root.textContent).toContain("识别出 1 卷 · 2 章");
    expect(allByRole(root, "listitem").map(item => item.textContent)).toEqual(["<img src=x>", "第二章"]); expect(allByRole(root, "img")).toHaveLength(0);
  });
  it("renders tracker filtering, export, detail return URL, edit/delete and pagination", () => {
    const html = ui.tracker(tracker);
    const root = parseHtml(html), filter = byAttribute(root, "action", "/tracker");
    expect(filter.getAttribute("method")).toBe("get");
    for (const name of ["q", "read_filter", "library_filter", "book_status_filter"]) expect(byName(filter, name)).toBeDefined();
    expect(byRole(root, "link", "导出 CSV").getAttribute("href")).toBe(tracker.export_url);
    for (const name of ["添加书籍", "编辑", "点此前往编辑该条目。"]) expect(byRole(root, "button", name)).toBeDefined();
    expect(byText(root, "更新")).toBeDefined(); expect(byRole(byRole(root, "navigation", "分页"), "link", "上一页")).toBeDefined();
    expect(byAttribute(root, "action", `/tracker/${wish.id}/delete`)).toBeDefined();
    expect(byRole(root, "link", /书名<script>.*打开书库详情/).getAttribute("href")).toBe(`/book/${wish.library_book_id}?return_to=${encodeURIComponent(tracker.current_url)}`);
    expect(root.textContent).toContain("书名<script>"); expect(root.getElementsByTagName("script").length).toBe(0);
    expect(ui.tracker({ ...tracker, wishes: [] })).toContain("没有符合筛选条件的书籍。");
  });
  it("renders all tracker form fields, completed/unread defaults and immutable linked identity", () => {
    const html = ui.form();
    for (const field of ["title", "author", "tags", "rating", "comment", "library_book_id", "read_status", "book_status", "next"]) expect(byName(parseHtml(html), field)).toBeDefined();
    for (const label of ["书名", "作者", "状态", "评分", "阅读状态", "未读", "在读", "已读", "更新中", "已断更", "已完结"]) expect(html).toContain(label);
    const root = parseHtml(html);
    for (const [name, value] of [["book_status", "completed"], ["read_status", "unread"]]) expect(byAttribute(byName(root, name!), "value", value).hasAttribute("selected")).toBe(true);
    const linked = parseHtml(ui.form(wish)); expect(byAttribute(linked, "action", `/tracker/${wish.id}/update`)).toBeDefined();
    for (const name of ["title", "author"]) expect(byName(linked, name).hasAttribute("readonly")).toBe(true);
    expect(linked.textContent).toContain("已入库条目的书名/作者由书库元数据维护");
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
