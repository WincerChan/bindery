import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { binderyIcons } from "../scripts/vite-icons";
import solid from "vite-plugin-solid";
import { mutationPlugin } from "./support/mutation-plugin";
import { resolve } from "node:path";
import type { EditorData } from "../src/server/catalog/templates";
import type { TrackerItem, TrackerPageData } from "../src/server/catalog/tracker";
import { legacyThemeRedirect, legacyThemeTarget } from "../src/features/catalog/settings-redirects";
import { formatCssText, themePreviewDocument } from "../src/features/catalog/client";

import { allByAttribute, allByRole, byAttribute, byLabel, byName, byRole, byText, parseHtml } from "./support/queries";
let ui: typeof import("./fixtures/catalog/ui-probe");
const editor: EditorData = { id: "default", name: "默认规则", version: "1", description: "默认切章规则", raw: '{"name":"<script>"}', saved: false, error: null };
const wish: TrackerItem = { id: "a".repeat(32), title: "书名<script>", author: "作者", library_book_id: "b".repeat(32), rating: 4, read: false, read_status: "reading", tags: ["科幻"], tags_text: "科幻", comment: "短评", book_status: "completed", created_at: "2026-04-01T10:00:00+00:00", updated_at: "2026-04-01T10:00:00+00:00", updated_at_display: "2026-04-01 10:00", read_status_label: "在读", book_status_label: "已完结", exists_in_library: true, exists_label: "已存在" };
const tracker: TrackerPageData = { reading_now: [wish], filters: { q: "科幻", read_filter: "all", library_filter: "all", book_status_filter: "all" }, stats: { total: 25, filtered: 25, read: 0, reading: 1, unread: 24, in_library: 1, out_library: 24 }, wishes: [wish], page: 2, total_pages: 2, current_url: "/tracker?q=科幻&page=2", export_url: "/tracker/export?q=科幻", duplicate_notice: wish };
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [...binderyIcons(), mutationPlugin(), solid({ ssr: true })], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/catalog/ui-probe.tsx") } });
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
    for (const copy of ["粘贴一段 TXT，输入后自动运行", "粘贴一段文本后"]) expect(root.textContent).toContain(copy);
    expect(allByAttribute(root, "action", "/rules/default/delete")).toHaveLength(0);
    expect(byName(root, "config_json").textContent).toContain("<script>"); expect(root.getElementsByTagName("script").length).toBe(0);
    expect(byLabel(root, "规则 JSON")).toBe(byName(root, "config_json"));
    expect(byName(root, "config_json").getAttribute("wrap")).toBe("soft");
    expect(byName(root, "config_json").getAttribute("rows")).toBe("8");
    expect(byLabel(root, "试切")).toBe(byName(root, "sample"));
    expect(byRole(root, "button", "保存").getAttribute("type")).toBe("submit");
    // A server-rendered form must remain submittable before hydration / without JavaScript.
    expect(byRole(root, "button", "保存").hasAttribute("disabled")).toBe(false);
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
    expect(byRole(root, "heading", "切章规则")).toBeDefined();
    expect(byRole(root, "link", "设置").getAttribute("href")).toBe("/settings");
    expect(byRole(byRole(root, "navigation", "规则列表"), "link", /默认规则/).getAttribute("aria-current")).toBe("page");
    expect(byRole(root, "alert").textContent).toBe("引用错误"); expect(allByRole(root, "link", "主题")).toHaveLength(0);
    expect(byRole(themes, "heading", "主题")).toBeDefined();
    expect(byRole(byRole(themes, "navigation", "主题列表"), "link", /默认样式/).getAttribute("href")).toBe("/themes?theme_id=default");
    expect(themes.textContent).toContain("v1 · 内置 · 入库默认");
    expect(byAttribute(themes, "action", "/themes/new")).toBeDefined(); expect(byName(themes, "scope").getAttribute("value")).toBe("themes");
  });
  it("disables deletion for active and archived use and retains naming, restore and test actions", () => {
    for (const [book_count, archived_count] of [[3, 0], [1, 1], [0, 1]]) {
      const custom = { ...editor, id: "custom", name: "自定义" };
      const root = parseHtml(ui.rules({ rules: [{ ...custom, book_count: book_count!, archived_count: archived_count! }], themes: [], tab: "parsing", ruleId: "custom", themeId: "default", error: "", editor: custom }));
      expect(byRole(byAttribute(root, "action", "/rules/custom/delete"), "button", "删除这条规则").hasAttribute("disabled")).toBe(true);
      expect(root.textContent).toContain("在库或已归档的书仍在使用，不能删除。");
      for (const name of ["另存为", "重命名", "还原", "格式化"]) expect(byRole(root, "button", name)).toBeDefined();
      expect(byRole(root, "button", "删除这条规则")).toBeDefined();
    }
    const custom = { ...editor, id: "unused" };
    const root = parseHtml(ui.rules({ rules: [{ ...custom, book_count: 0, archived_count: 0 }], themes: [], tab: "parsing", ruleId: "unused", themeId: "default", error: "", editor: custom }));
    expect(byRole(byAttribute(root, "action", "/rules/unused/delete"), "button", "删除这条规则").hasAttribute("disabled")).toBe(false);
  });
  it("preserves theme selection, flash and fragment in the legacy permanent redirect", () => {
    const href = "/rules?tab=themes&theme_id=theme-a&error=used#theme-editor";
    expect(legacyThemeTarget(href)).toBe("/themes?theme_id=theme-a&error=used#theme-editor");
    expect(legacyThemeRedirect(href)).toEqual({ href: legacyThemeTarget(href), replace: true, statusCode: 308 });
    expect(legacyThemeTarget("/rules?tab=parsing&rule_id=a")).toBeNull();
    expect(legacyThemeTarget("/rules?tab=themes")).toBe("/themes");
  });
  it("renders escaped TOC counts and empty results", () => {
    expect(ui.preview(null)).toContain("粘贴一段文本后");
    const root = parseHtml(ui.preview({ volumes: 1, chapters: 2, toc: ["<img src=x>", "第二章"] }));
    expect(root.textContent).toContain("识别出 1 卷 2 章");
    expect(allByRole(root, "listitem").map(item => item.textContent)).toEqual(["<img src=x>", "第二章"]); expect(allByRole(root, "img")).toHaveLength(0);
  });
  it("renders tracker filtering, export, detail return URL, edit/delete and pagination", () => {
    const html = ui.tracker(tracker);
    const root = parseHtml(html), filter = byAttribute(root, "action", "/tracker");
    expect(filter.getAttribute("method")).toBe("get");
    for (const name of ["q", "read_filter", "library_filter", "book_status_filter"]) expect(byName(filter, name)).toBeDefined();
    expect(byRole(root, "link", "导出 CSV").getAttribute("href")).toBe(tracker.export_url);
    for (const name of ["添加书籍", "点此前往编辑该条目。"]) expect(byRole(root, "button", name)).toBeDefined();
    expect(byRole(root, "heading", "正在读的有 1 本，还有 24 本在等你。")).toBeDefined();
    const readTabs = byRole(root, "navigation", "阅读状态");
    expect(byRole(readTabs, "link", "全部").getAttribute("aria-current")).toBe("page");
    const unread = new URL(byRole(readTabs, "link", "未读").getAttribute("href")!, "http://localhost");
    expect(unread.searchParams.get("q")).toBe("科幻"); expect(unread.searchParams.get("read_filter")).toBe("unread");
    expect(byRole(root, "combobox", "书库")).toBeDefined();
    expect(byRole(root, "combobox", "连载")).toBeDefined();
    const list = byRole(root, "list", "追踪列表");
    const trigger = allByRole(list, "button", /《书名<script>》的操作/).find(button => button.hasAttribute("aria-haspopup"))!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-label")).toBe("《书名<script>》的操作");
    expect((trigger.textContent || "").trim()).toBe("");
    expect(byRole(list, "img", "4 星")).toBeDefined();
    expect(byRole(byRole(root, "navigation", "分页"), "link", "上一页")).toBeDefined();
    expect(byRole(list, "link", /打开《书名<script>》详情/).getAttribute("href")).toBe(`/book/${wish.library_book_id}?return_to=${encodeURIComponent(tracker.current_url)}`);
    expect(root.textContent).toContain("书名<script>"); expect(root.getElementsByTagName("script").length).toBe(0);
    expect(ui.tracker({ ...tracker, wishes: [] })).toContain("没有符合筛选条件的书籍。");
  });
  it("keeps library navigation conditional, keeps menu actions, and handles the no-reading intro", () => {
    const manual = { ...wish, id: "c".repeat(32), title: "未入库的书", library_book_id: null, exists_in_library: false, rating: null };
    const root = parseHtml(ui.tracker({ ...tracker, wishes: [wish, manual] }));
    const rows = allByRole(byRole(root, "list", "追踪列表"), "listitem");
    expect(byRole(rows[0]!, "menuitem", "在书库中打开")).toBeDefined();
    expect(allByRole(rows[1]!, "menuitem", "在书库中打开")).toHaveLength(0);
    for (const row of rows) {
      expect(byRole(row, "menuitem", "编辑追踪")).toBeDefined();
      expect(byRole(row, "menuitem", "删除追踪")).toBeDefined();
    }
    expect(byAttribute(rows[1]!, "class", "tracker-row-state").textContent).toBe("在读 · 未入库");
    expect(allByRole(rows[1]!, "status")).toHaveLength(0);
    expect(allByRole(rows[1]!, "img", /星/)).toHaveLength(0);
    const empty = parseHtml(ui.tracker({ ...tracker, reading_now: [], wishes: [], duplicate_notice: null, filters: { ...tracker.filters, q: "" }, stats: { ...tracker.stats, reading: 0, unread: 0, total: 0, filtered: 0, in_library: 0 } }));
    expect(byRole(empty, "heading", "还有 0 本在等你。")).toBeDefined();
    expect(allByRole(empty, "region", "正在读")).toHaveLength(0);
    expect(empty.textContent).toContain("还没有追踪的书籍");
  });
  it("separates secondary tracker metadata without empty author separators or blank rows", () => {
    const wishes = [wish, { ...wish, id: "manual", author: "", tags: ["奇幻"], book_status: "ongoing", book_status_label: "更新中" }, { ...wish, id: "empty", author: "", tags: [] }];
    const root = parseHtml(ui.tracker({ ...tracker, wishes }));
    const rows = allByRole(byRole(root, "list", "追踪列表"), "listitem");
    expect(byAttribute(rows[0]!, "class", "tracker-meta").textContent).toBe("在读 · 作者 · 科幻");
    expect(byAttribute(rows[0]!, "class", "tracker-meta-secondary").textContent).toBe(" · 科幻");
    expect(byAttribute(rows[1]!, "class", "tracker-meta").textContent).toBe("在读 · 更新中 · 奇幻");
    expect(byAttribute(rows[1]!, "class", "tracker-meta-secondary").textContent).toBe("更新中 · 奇幻");
    expect(byAttribute(rows[2]!, "class", "tracker-meta").textContent).toBe("在读");
    expect(allByAttribute(rows[2]!, "class", "tracker-meta-secondary")).toHaveLength(0);
  });
  it("shows each tracker state inline in the row and keeps the menu to its actions", () => {
    const wishes = [
      { ...wish, id: "read", read_status: "read", read_status_label: "已读" },
      { ...wish, id: "reading", read_status: "reading", read_status_label: "在读" },
      { ...wish, id: "unread", read_status: "unread", read_status_label: "未读" },
      { ...wish, id: "manual", read_status: "reading", read_status_label: "在读", library_book_id: null, exists_in_library: false, author: "", tags: [], book_status: "completed" },
    ];
    const root = parseHtml(ui.tracker({ ...tracker, wishes }));
    const rows = allByRole(byRole(root, "list", "追踪列表"), "listitem");
    const labels = ["已读", "在读", "未读", "在读 · 未入库"], tones = ["ui-status-ok", "ui-status-accent", "ui-status-empty", "ui-status-accent"];
    rows.forEach((row, index) => {
      expect(byAttribute(row, "class", "tracker-row-state").textContent).toBe(labels[index]);
      const dot = byAttribute(row, "class", /ui-status-dot/);
      expect(dot.getAttribute("class")).toContain(tones[index]!);
      expect(dot.getAttribute("aria-hidden")).toBe("true");
      expect(dot.hasAttribute("aria-label")).toBe(false);
      expect(dot.hasAttribute("role")).toBe(false);
      expect(allByRole(row, "status")).toHaveLength(0);
      expect((row.textContent?.match(new RegExp(labels[index]!.split(" · ")[0]!, "g")) || []).length).toBe(1);
      expect(byRole(row, "menuitem", "编辑追踪")).toBeDefined();
      expect(byRole(row, "menuitem", "删除追踪")).toBeDefined();
    });
    expect(rows[3]!.textContent?.match(/未入库/g)).toHaveLength(1);
  });
  it("renders all tracker form fields, completed/unread defaults and immutable linked identity", () => {
    const html = ui.form();
    for (const field of ["title", "author", "tags", "rating", "comment", "library_book_id", "read_status", "book_status", "next"]) expect(byName(parseHtml(html), field)).toBeDefined();
    for (const label of ["书名", "作者", "状态", "评分", "阅读状态", "未读", "在读", "已读", "更新中", "已断更", "已完结"]) expect(html).toContain(label);
    const root = parseHtml(html);
    for (const [name, value] of [["book_status", "completed"], ["read_status", "unread"]]) expect(byName(root, name!).getAttribute("value")).toBe(value);
    expect(byRole(byRole(root, "group", "阅读状态"), "button", "未读").getAttribute("aria-pressed")).toBe("true");
    expect(byRole(byRole(root, "group", "连载状态"), "button", "已完结").getAttribute("aria-pressed")).toBe("true");
    expect(byRole(root, "button", "保存").getAttribute("type")).toBe("submit");
    const linked = parseHtml(ui.form(wish)); expect(byAttribute(linked, "action", `/tracker/${wish.id}/update`)).toBeDefined();
    expect(byRole(linked, "heading", wish.title)).toBeDefined();
    for (const name of ["title", "author"]) { expect(byName(linked, name).getAttribute("type")).toBe("hidden"); expect(byName(linked, name).getAttribute("value")).toBeTruthy(); }
    expect(linked.textContent).toContain("书名和作者跟随书库");
    expect(byRole(linked, "button", "4 星").getAttribute("aria-pressed")).toBe("true");
    expect(byRole(linked, "button", "清除评分")).toBeDefined();
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
