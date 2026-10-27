import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
import { mutationPlugin } from "./support/mutation-plugin";

import { allByAttribute, allByRole, byAttribute, byName, byRole, parseHtml } from "./support/queries";
let ui: typeof import("./fixtures/library/ui-probe");
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [mutationPlugin(), solid({ ssr: true })], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/library/ui-probe.tsx") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing library SSR bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
});
describe("library SSR behavior", () => {
  it.each(["grid", "list"] as const)("uses labelled sibling detail/reading links with return_to in %s view", view => {
    const html = ui.item("00", null, view);
    const root = parseHtml(html);
    expect(allByAttribute(root, "data-book-card")).toHaveLength(1);
    const links = allByRole(root, "link"), hrefs = links.map(link => link.getAttribute("href")!);
    // Read links skip the /preview entry redirect and open the reader at the saved position.
    expect(hrefs.filter(href => href.includes("/preview/0?resume=1&return_to="))).toHaveLength(2);
    expect(hrefs.filter(href => href.endsWith("/download"))).toHaveLength(1);
    // Only non-default parameters: the default sort and page size stay out of the return URL.
    expect(byName(root, "next").getAttribute("value")).toBe("/?q=%E9%95%BF%E5%AE%89&read_filter=unread&page=2"); expect(html).not.toContain("per_page=");
    // Independent links remain operable; no anchor may contain another anchor.
    for (const link of links) expect(allByRole(link, "link")).toHaveLength(0);
    expect(html).not.toContain("/private/library"); expect(html).not.toContain("/regenerate"); expect(html).not.toContain("已写回元数据"); expect(html).toContain("已读");
    expect(root.textContent).toContain("长安<&>的荔枝");
  });
  it("renders one lazy real cover per book and keyboard-operable selection without detail navigation", () => {
    const html = ui.item("00", "/book/cover?v=1", "grid");
    const cover = byRole(parseHtml(html), "img");
    expect(cover.getAttribute("loading")).toBe("lazy"); expect(cover.getAttribute("src")).toBe("/book/cover?v=1");
    const selected = parseHtml(ui.item("00", null, "grid", true));
    expect(allByAttribute(selected, "data-book-detail-link")).toHaveLength(0);
    expect(allByRole(selected, "link", "阅读")).toHaveLength(1); // Only the normal action, not the cover's reading overlay.
    expect(byRole(selected, "button", "选择《长安<&>的荔枝》").getAttribute("aria-pressed")).toBe("true");
    expect(byRole(selected, "checkbox", "选择《长安<&>的荔枝》").hasAttribute("checked")).toBe(true);
  });
  it("renders search/filter/sort, multi-select toolbar, native POST forms and pagination", () => {
    const html = ui.page(), root = parseHtml(html);
    for (const name of ["q", "sort", "read_filter", "page", "per_page"]) expect(byName(root, name)).toBeDefined();
    for (const hook of ["data-bulk-mode-toggle", "data-bulk-actions", "data-bulk-select-all", "data-bulk-clear", "data-bulk-done", "data-read-filter-toggle", "data-pagination-total"]) expect(byAttribute(root, hook)).toBeDefined();
    for (const action of ["/books/archive", "/books/download"]) expect(byAttribute(root, "action", action).getAttribute("method")).toBe("post");
    expect(html).toContain("归档后可在书库「已归档」中恢复"); expect(html).toContain("重新生成"); expect(html).toContain("仅看未读"); expect(byAttribute(root, "data-pagination-total").textContent).toBe("49");
    const pager = byRole(root, "navigation", "分页");
    for (const name of ["上一页", "下一页"]) expect(byRole(pager, "link", name)).toBeDefined();
    expect(pager.textContent).toContain("25–25 册 · 共");
    expect(html).not.toContain('action="/upload'); expect(html).not.toContain('action="/ingest"'); expect(html).not.toContain("书库共有");
  });
  it("keeps empty library copy and omits empty archive controls/headers", () => {
    const empty = parseHtml(ui.page(true));
    expect(empty.textContent).toContain("书库还是空的"); expect(byRole(empty, "link", "入库第一本书").getAttribute("href")).toBe("/ingest");
    const archive = parseHtml(ui.archive(true));
    expect(archive.textContent).toContain("归档为空。"); expect(allByRole(archive, "link", "入库第一本书")).toHaveLength(0);
    expect(allByAttribute(archive, "data-archive-select-all")).toHaveLength(0);
    expect(byRole(byAttribute(archive, "action", "/archive/delete-bulk"), "button", "彻底删除").hasAttribute("disabled")).toBe(true);
    expect(archive.textContent).not.toContain("书名 / 作者");
  });
  it.each(["grid", "list"] as const)("renders archived books with safe actions and selection in %s view", view => {
    const html = ui.archive(false, view), root = parseHtml(html);
    for (const hook of ["data-bulk-select-all", "data-bulk-actions", "data-book-select", "data-bulk-clear", "data-book-ids"]) expect(allByAttribute(root, hook).length).toBeGreaterThan(0);
    expect(byAttribute(root, "data-pagination-total")).toBeDefined(); expect(root.textContent).toContain("25–25 册 · 共");
    expect(root.getElementsByTagName("img").length).toBe(0); // A generated, named cover is fine; no private image is requested.
    expect(allByRole(byAttribute(root, "data-book-card"), "link")).toHaveLength(0);
    for (const absent of ["/private-cover", "/download", "/regenerate", "批量归档", "仅看未读"]) expect(html).not.toContain(absent);
    expect(allByAttribute(root, "name", "next").every(field => field.getAttribute("value")?.startsWith("/?scope=archived"))).toBe(true);
    expect(allByRole(root, "button", "恢复").length).toBeGreaterThan(0);
    for (const action of [/\/restore$/, /\/delete$/, /^\/archive\/delete-bulk$/]) {
      const forms = allByAttribute(root, "action", action);
      expect(forms.length).toBeGreaterThan(0); for (const form of forms) expect(form.getAttribute("method")).toBe("post");
    }
    expect(html).toContain("永久删除书籍"); expect(html).toContain("无法恢复"); expect(html).toContain("书名 / 作者");
  });
  it("renders the selected book and current page in a library section", () => {
    const root = parseHtml(ui.section());
    expect(byAttribute(root, "id", "library-section").getAttribute("data-page")).toBe("2");
    const selection = byRole(root, "checkbox", "选择《长安<&>的荔枝》");
    expect(selection.hasAttribute("checked")).toBe(true); expect(selection.getAttribute("value")).toBe("00" + "a".repeat(30));
  });
});
