import { beforeAll, describe, it, expect } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { mutationPlugin } from "./support/mutation-plugin";
import { resolve } from "node:path";
import type { BookPage } from "../src/server/books/service";
import { metadataFromDict } from "../src/core/models";
import { bookNavigation } from "../src/features/books/navigation";
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
    const html = ui.detail(page());
    for (const suffix of [
      "/download",
      "/read",
      "/archive",
      "/delete",
      "/regenerate",
    ])
      expect(html).toContain(`/book/${"a".repeat(32)}${suffix}`);
    expect(html).toContain("/preview/0?resume=1&amp;return_to=");
    expect(html).toContain("示例书&lt;&amp;>");
    expect(html).toContain('aria-label="阅读状态"');
    expect(html).toContain("✓ 已读");
    expect(html).toContain("标记未读");
    expect(html).toContain("下载 EPUB");
    expect(html).toContain("编辑");
  });
  it("uses specification list with dates, description and no cover controls or identifier", () => {
    const html = ui.detail(page());
    expect(html).toContain("<dl");
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
    expect(html).toContain("return_to=%2F%3Fq%3D%E4%B9%A6%26page%3D2");
    expect(html).toContain('name="next" value="/?q=书&amp;page=2"');
  });
  it("lists each reading source with section, percent, times, estimates and the newest marker", () => {
    const value = page();
    value.reading_progress = [
      { source: "web", source_label: "网页阅读器", section: 1, section_fraction: 0.5, percent: 50, read_at: "2026-10-22T13:00:00Z", time_spent_seconds: null, rest_estimate_seconds: null, section_title: "第二章 重逢", latest: false },
      { source: { device_id: "kobo-1", device_name: "Libra 2", kind: "kobo" }, source_label: "Libra 2", section: 2, section_fraction: 0.2, percent: 70, read_at: "2026-10-22T13:11:20Z", time_spent_seconds: 132, rest_estimate_seconds: 8943, section_title: "第三章 再见", latest: true },
    ];
    const html = ui.detail(value).replace(/<!--.*?-->/g, "");
    expect(html).toContain("阅读进度");
    expect(html).toContain("网页阅读器");
    expect(html).toContain("Libra 2");
    expect(html).toContain("第二章 重逢 · 50%");
    expect(html).toContain("第三章 再见 · 70%");
    // The server renders UTC; the browser switches the <time> to the reader's own zone after mounting.
    expect(html).toMatch(/上次阅读 <time[^>]*datetime="2026-10-22T13:11:20Z"[^>]*>2026-10-22 13:11<\/time>/);
    expect(html).toContain("用时 约 2 分钟");
    expect(html).toContain("剩余 约 3 小时");
    expect(html).toContain("最新");
    expect(ui.detail(page()).replace(/<!--.*?-->/g, "")).not.toContain("阅读进度");
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
    expect(html.match(/保存并写回/g)).toHaveLength(1);
    expect(html).toContain('enctype="multipart/form-data"');
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
      expect(html).toContain(`name="${name}"`);
    expect(html).not.toContain('name="identifier"');
    expect(html).not.toContain("contenteditable");
    expect(html).toContain('aria-label="3 星"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("清除");
    expect(html).toContain("自动填充信息");
    expect(html).toContain("/metadata/fetch");
    expect(html).not.toContain("<main");
  });
  it("provides CSS formatter, keep-book theme and original CSS checkbox", () => {
    const html = ui.editor(page());
    expect(html).toContain('data-format-target="book-custom-css"');
    expect(html).toContain('id="book-custom-css"');
    expect(html).toContain("格式化");
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
    expect(html).toContain('role="alert"');
    expect(html).toContain("失败 &lt;script>");
    expect(html).toContain("books-autofill");
    expect(html).toContain("https://source.test/a.png");
    expect(html).toContain("https://applied.test/a.png");
  });
  it("uses a native confirmation dialog with explicit cancel and confirm actions", () => {
    const html = ui.detail(page());
    expect(html).toContain("<dialog");
    expect(html).toContain("确定要永久删除这本书吗？");
    expect(html).toContain("取消");
    expect(html).toContain("无法恢复");
  });
});
