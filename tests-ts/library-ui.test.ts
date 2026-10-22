import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
import { mutationPlugin } from "./support/mutation-plugin";

let ui: typeof import("./fixtures/library/ui-probe");
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [mutationPlugin(), solid({ ssr: true })], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/library/ui-probe.tsx") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing library SSR bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
describe("library SSR and editorial UI regressions", () => {
  it.each(["grid", "list"] as const)("uses labelled sibling detail/reading links with return_to in %s view", view => {
    const html = ui.item("00", null, view);
    expect(html).toContain('data-book-card'); expect(html).toContain(`data-book-layout="${view}"`);
    const hrefs = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>/g)].map(match => match[1]!);
    expect(hrefs.filter(href => href.includes("/preview?return_to="))).toHaveLength(2);
    expect(hrefs.filter(href => href.endsWith("/download"))).toHaveLength(1);
    // Only non-default parameters: the default sort and page size stay out of the return URL.
    expect(html).toContain('name="next" value="/?q=%E9%95%BF%E5%AE%89&amp;read_filter=unread&amp;page=2"'); expect(html).not.toContain("per_page=");
    let depth = 0;
    for (const token of html.matchAll(/<\/?a\b[^>]*>/g)) { if (token[0].startsWith("</")) depth--; else { expect(depth).toBe(0); depth++; } }
    expect(depth).toBe(0);
    expect(html).not.toContain("/private/library"); expect(html).not.toContain("/regenerate"); expect(html).not.toContain("已写回元数据"); expect(html).toContain("已读");
    expect(html).toContain("长安&lt;&amp;>的荔枝");
  });
  it.each(["00", "01", "02", "03", "04", "ff"])("reuses stable generated cover tone for %s", prefix => {
    const html = ui.item(prefix, null, "grid");
    expect(html).toContain(`cover-tone-${parseInt(prefix, 16) % 5}`); expect(html).toContain('class="cover-gen-inner"');
    expect(ui.item(prefix, null, "list")).toContain("cover-compact");
  });
  it("renders one lazy real cover per book and keyboard-operable selection without detail navigation", () => {
    const html = ui.item("00", "/book/cover?v=1", "grid");
    expect(html.match(/<img/g)).toHaveLength(1); expect(html).toContain('loading="lazy"'); expect(html).toContain('src="/book/cover?v=1"');
    const selected = ui.item("00", null, "grid", true);
    expect(selected).not.toContain("data-book-detail-link"); expect(selected).not.toContain("data-book-hover-actions");
    expect(selected).toContain('aria-pressed="true"'); expect(selected).toContain('type="checkbox"'); expect(selected).toContain("选择《");
  });
  it("renders search/filter/sort, multi-select toolbar, native POST forms and pagination", () => {
    const html = ui.page();
    for (const name of ["q", "sort", "read_filter", "page", "per_page"]) expect(html).toContain(`name="${name}"`);
    for (const hook of ["data-bulk-mode-toggle", "data-bulk-actions", "data-bulk-select-all", "data-bulk-clear", "data-bulk-done", "data-read-filter-toggle", "data-library-count"]) expect(html).toContain(hook);
    expect(html).toContain('action="/books/archive" method="post"'); expect(html).toContain('action="/books/download" method="post"');
    expect(html).toContain("归档后可在书库「已归档」中恢复"); expect(html).toContain("重新生成"); expect(html).toContain("仅看未读"); expect(html.replace(/<!--[\s\S]*?-->/g, "")).toContain("49</span>");
    expect(html).toContain('aria-label="分页"'); expect(html).toContain("上一页"); expect(html).toContain("下一页"); expect(html.replace(/<!--[\s\S]*?-->/g, "")).toContain("25–25 / 49");
    expect(html).not.toContain('action="/upload'); expect(html).not.toContain('action="/ingest"'); expect(html).not.toContain("书库共有");
  });
  it("keeps empty library copy and omits empty archive controls/headers", () => {
    expect(ui.page(true)).toContain("书库还是空的"); expect(ui.page(true)).toContain("入库第一本书");
    const html = ui.archive(true);
    expect(html).toContain("归档为空。"); expect(html).not.toContain("入库第一本书"); expect(html).not.toContain("data-archive-select-all"); expect(html).not.toContain('id="archive-bulk-delete-form"'); expect(html).not.toContain("书名 / 作者");
  });
  it.each(["grid", "list"] as const)("renders archived books with safe actions and selection in %s view", view => {
    const html = ui.archive(false, view);
    for (const hook of ["data-bulk-select-all", "data-bulk-actions", "data-book-select", "data-bulk-clear", "data-book-ids"]) expect(html).toContain(hook);
    expect(html.replace(/<!--[\s\S]*?-->/g, "")).toMatch(/已归档 <span[^>]*data-library-count>49</);
    for (const absent of ["data-book-detail-link", "data-book-hover-actions", "/private-cover", "/download", "/regenerate", "批量归档", "仅看未读", '<img']) expect(html).not.toContain(absent);
    expect(html).toContain("cover-gen-inner"); expect(html).toContain('name="next" value="/?scope=archived');
    expect(html).toContain('class="btn btn-danger btn-sm');
    expect(html).toContain(">恢复<"); expect(html).toContain('action="/archive/delete-bulk" method="post"');
    expect(html).toContain('/restore" method="post"'); expect(html).toContain('/delete" method="post"');
    expect(html).toContain("永久删除书籍"); expect(html).toContain("无法恢复"); expect(html).toContain("书名 / 作者");
  });
  it("renders selected hidden IDs and partial pagination without duplicating a main landmark", () => {
    const html = ui.section(); expect(html).toContain('id="library-section"'); expect(html).toContain('data-page="2"');
    expect(html).toContain('checked'); expect(html).not.toContain("<main");
  });
});
