import { beforeAll, describe, it, expect } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { mutationPlugin } from "./support/mutation-plugin";
import { resolve } from "node:path";
import type { BookPage } from "../src/server/books/service";
import { metadataFromDict } from "../src/core/models";
import { bookNavigation } from "../src/features/books/navigation";
import { allByAttribute, allByRole, byAttribute, byLabel, byName, byRole, byText, parseHtml } from "./support/queries";
let ui: typeof import("./fixtures/books/ui-probe");
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [mutationPlugin(), solid({ ssr: true })],
    ssr: { noExternal: true },
    build: {
      write: false,
      minify: false,
      ssr: resolve("tests-ts/fixtures/books/ui-probe.tsx"),
    },
  });
  const entry = (Array.isArray(result) ? result : [result])
    .flatMap((r) => ("output" in r ? r.output : []))
    .find((o) => o.type === "chunk" && o.isEntry);
  if (!entry || entry.type !== "chunk")
    throw new Error("Missing UI SSR bundle");
  ui = await import(
    /* @vite-ignore */ "data:text/javascript;base64," +
      Buffer.from(entry.code).toString("base64")
  );
});
function page(): BookPage {
  const id = "a".repeat(32);
  return {
    book: {
      ...metadataFromDict({
        book_id: id,
        title: "示例书<&>",
        author: "作者",
        description: "第一段\n\n第二段",
        series: "系列",
        publisher: "出版社",
        published: "2024-08-15T00:00:00+00:00",
        isbn: "1234567890",
        tags: ["小说", "文学"],
        rating: 3,
        read: true,
        rule_template: "default",
        updated_at: "2026-02-06T10:20:30+00:00",
        created_at: "2026-02-01T10:20:30+00:00",
      }),
      status_label: "已写回元数据",
      status_class: "ok",
      effective_theme_template: "default",
      can_regenerate: true,
      path: "unused",
      cover_url: null,
      word_count: null,
      file_size: null,
    },
    navigation: bookNavigation(id, "/?q=书&page=2"),
    rules: [{ rule_id: "default", name: "默认规则", version: "1" }],
    themes: [{ theme_id: "default", name: "默认主题", version: "1" }],
    strip_original_css: false,
    strip_fonts: false,
  };
}
describe("book detail and edit SSR", () => {
  it("renders detail actions, escaped title and Chinese reading state", () => {
    const root = parseHtml(ui.detail(page()));
    for (const suffix of ["read", "archive", "delete", "regenerate"]) expect(byAttribute(root, "action", `/book/${"a".repeat(32)}/${suffix}`).getAttribute("method")).toBe("post");
    expect(byRole(root, "link", "下载 EPUB").getAttribute("href")).toBe(`/book/${"a".repeat(32)}/download`);
    expect(byRole(root, "link", "阅读").getAttribute("href")).toContain("/preview/0?resume=1&return_to=");
    expect(byRole(root, "heading", "示例书<&>")).toBeDefined();
    expect(byAttribute(root, "aria-label", "阅读状态").textContent).toContain("已读");
    expect(byRole(root, "button", "标记未读")).toBeDefined(); expect(byRole(root, "link", "编辑")).toBeDefined();
  });
  it("shows specifications, dates and description without cover controls or identifier", () => {
    const html = ui.detail(page());
    const root = parseHtml(html);
    expect(root.textContent).toContain("第一段"); expect(root.textContent).toContain("第二段");
    for (const label of [
      "系列",
      "出版社",
      "出版日期",
      "ISBN",
      "标签",
      "来源",
      "规则模板",
      "状态",
      "入库时间",
      "更新时间",
      "简介",
    ])
      expect(html).toContain(label);
    expect(html).toContain("2024-08-15");
    expect(html).toContain("小说、文学");
    expect(html).not.toContain("Identifier");
    for (const path of ["/cover/upload", "/cover/url", "/cover/extract"])
      expect(html).not.toContain(path);
    expect(html).not.toContain("<main");
  });
  it("keeps return_to in edit, read and preview links and return path in destructive forms", () => {
    const html = ui.detail(page());
    const root = parseHtml(html);
    for (const name of ["编辑", "阅读"]) expect(new URL(byRole(root, "link", name).getAttribute("href")!, "https://bindery.test").searchParams.get("return_to")).toBe("/?q=书&page=2");
    for (const action of ["archive", "delete"]) expect(byName(byAttribute(root, "action", `/book/${"a".repeat(32)}/${action}`), "next").getAttribute("value")).toBe("/?q=书&page=2");
  });
  it("lists each reading source with section, percent, times, estimates and the newest marker", () => {
    const value = page();
    value.reading_progress = [
      { source: "web", source_label: "网页阅读器", section: 1, section_fraction: 0.5, percent: 50, read_at: "2026-10-22T13:00:00Z", time_spent_seconds: null, rest_estimate_seconds: null, section_title: "第二章 重逢", latest: false },
      { source: { device_id: "kobo-1", device_name: "Libra 2", kind: "kobo" }, source_label: "Libra 2", section: 2, section_fraction: 0.2, percent: 70, read_at: "2026-10-22T13:11:20Z", time_spent_seconds: 132, rest_estimate_seconds: 8943, section_title: "第三章 再见", latest: true },
    ];
    const root = parseHtml(ui.detail(value)), html = root.textContent!;
    expect(html).toContain("阅读进度");
    expect(html).toContain("网页阅读器");
    expect(html).toContain("Libra 2");
    expect(html).toContain("第二章 重逢 · 50%");
    expect(html).toContain("第三章 再见 · 70%");
    // The server renders UTC; the browser switches the <time> to the reader's own zone after mounting.
    expect(byAttribute(root, "datetime", "2026-10-22T13:11:20Z").textContent).toBe("2026-10-22 13:11");
    expect(root.textContent).toContain("上次阅读");
    expect(html).toContain("用时 约 2 分钟");
    expect(html).toContain("剩余 约 3 小时");
    expect(html).toContain("最新");
    expect(allByRole(parseHtml(ui.detail(page())), "region", "阅读进度")).toHaveLength(0);
  });
  it("hides regenerate controls without TXT source and renders EPUB source label", () => {
    const value = page();
    value.book.can_regenerate = false;
    value.book.source_type = "epub";
    const html = ui.detail(value);
    expect(html).not.toContain("重新生成 EPUB");
    expect(html).toContain("EPUB 直接入库");
  });
  it("renders one save action, native labelled fields, cover inputs and accessible ratings", () => {
    const html = ui.editor(page());
    const root = parseHtml(html);
    expect(allByRole(root, "button", "保存并写回")).toHaveLength(1);
    const form = byAttribute(root, "action", `/book/${"a".repeat(32)}/edit`);
    expect(form.getAttribute("enctype")).toBe("multipart/form-data");
    for (const name of [
      "title",
      "author",
      "language",
      "series",
      "rating",
      "publisher",
      "tags",
      "published",
      "isbn",
      "cover_file",
      "cover_url",
      "description",
      "rule_template",
      "theme_template",
      "custom_css",
      "return_to",
      "metadata_source",
      "strip_original_css",
    ])
      expect(byName(form, name)).toBeDefined();
    expect(allByAttribute(root, "name", "identifier")).toHaveLength(0);
    expect(allByAttribute(root, "contenteditable")).toHaveLength(0);
    expect(byRole(root, "button", "3 星").getAttribute("aria-pressed")).toBe("true");
    expect(html).toContain("清除");
    expect(html).toContain("自动填充信息");
    expect(html).toContain("/metadata/fetch");
    expect(html).not.toContain("<main");
  });
  it("provides CSS formatter, keep-book theme and original CSS checkbox", () => {
    const html = ui.editor(page());
    const root = parseHtml(html);
    expect(byRole(root, "button", "格式化").getAttribute("data-format-target")).toBe(byName(root, "custom_css").id);
    expect(html).toContain("保持书籍样式（仅 EPUB）");
    expect(html).toContain("清除原书 CSS（link/style）");
    expect(html).toContain("默认主题");
  });
  it("displays draft lookup feedback and distinguishes source/applied cover URLs", () => {
    const value = page();
    value.error = "失败 <script>";
    value.info = "已从 豆瓣 自动填充字段，请检查后再保存并写回。";
    value.lookup_changed_fields = ["title"];
    value.lookup_result = {
      query: "书",
      source: "豆瓣",
      title: "书",
      author: null,
      language: "zh-CN",
      publisher: null,
      published: null,
      isbn: null,
      cover_url: "https://source.test/a.png",
      applied_cover_url: "https://applied.test/a.png",
      tags: [],
      description: null,
      errors: [],
    };
    const html = ui.editor(value);
    const root = parseHtml(html);
    expect(byRole(root, "alert").textContent).toContain("失败 <script>");
    expect(root.getElementsByTagName("script").length).toBe(0);
    expect(allByRole(root, "status").map(node => node.textContent)).toContain(value.info);
    expect(byLabel(root, "书名")).toBeDefined();
    expect(html).toContain("https://source.test/a.png");
    expect(html).toContain("https://applied.test/a.png");
  });
  it("uses a native confirmation dialog with explicit cancel and confirm actions", () => {
    const html = ui.detail(page());
    const dialog = allByRole(parseHtml(html), "dialog").find(dialog => dialog.textContent?.includes("确定要永久删除这本书吗？"))!;
    expect(dialog).toBeDefined();
    expect(byRole(dialog, "button", "取消")).toBeDefined();
    expect(byRole(dialog, "button", "永久删除")).toBeDefined();
    expect(dialog.textContent).toContain("无法恢复");
  });
});
