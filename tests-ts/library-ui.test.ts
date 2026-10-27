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
  it("uses real shelf counts and title-length-aware introduction, not the current search result", () => {
    const root = parseHtml(ui.introduction("浮生六记"));
    expect(byRole(root, "heading", "最近阅读的，是《浮生六记》。")).toBeDefined();
    expect(byRole(root, "link", "在库51")).toBeDefined(); expect(byRole(root, "link", "已归档7")).toBeDefined();
    expect(byRole(root, "link", "继续阅读 ↗").getAttribute("href")).toContain("/preview/0?resume=1");
    expect(byRole(root, "link", "设备预览").getAttribute("href")).toContain("/devices/preview?book=");
    const long = parseHtml(ui.introduction("这是一本名字确实超过十二个字的书"));
    expect(byRole(long, "heading", "最近阅读的是这本。")).toBeDefined();
    expect(byRole(parseHtml(ui.introduction("新书", false)), "heading", "最近放进来的，是《新书》。")).toBeDefined();
  });
  it.each(["failed", "generating"] as const)("explains graphical %s state without technical status tags", state => {
    const root = parseHtml(ui.item("00", null, "grid", false, state)), menu = byRole(root, "menu");
    expect(byRole(root, "img").getAttribute("aria-label")).toContain(state === "failed" ? "生成失败" : "生成中");
    expect(byAttribute(root, "data-book-detail-link").getAttribute("aria-label")).toContain(state === "failed" ? "生成失败" : "生成中");
    if (state === "failed") expect(byRole(byRole(root, "dialog"), "status").textContent).toContain("点封面查看并重试");
    else { expect(allByRole(root, "status")).toHaveLength(0); expect(byRole(menu, "menuitem", "查看生成进度").getAttribute("href")).toBe("/ingest?jobs_tab=running#jobs"); }
    expect(root.textContent).not.toContain("已写回元数据");
  });
  it.each(["grid", "list"] as const)("uses labelled sibling detail/reading links with return_to in %s view", view => {
    const html = ui.item("00", null, view);
    const root = parseHtml(html);
    expect(allByAttribute(root, "data-book-card")).toHaveLength(1);
    const menu = byRole(root, "menu"), links = allByRole(root, "link"), hrefs = allByRole(menu, "menuitem").map(link => link.getAttribute("href") || "");
    expect(byRole(root, "button", /长安.*的荔枝.*马伯庸/).getAttribute("aria-haspopup")).toBe("menu");
    expect(allByAttribute(root, "data-book-detail-link")).toHaveLength(1);
    expect(allByRole(menu, "menuitem", "归档")).toHaveLength(1);
    // Read links skip the /preview entry redirect and open the reader at the saved position.
    expect(hrefs.filter(href => href.includes("/preview/0?resume=1&return_to="))).toHaveLength(1);
    expect(hrefs.filter(href => href.endsWith("/download"))).toHaveLength(1);
    // Only non-default parameters: the default sort and page size stay out of the return URL.
    expect(byName(menu, "next").getAttribute("value")).toBe("/?q=%E9%95%BF%E5%AE%89&read_filter=unread&page=2"); expect(html).not.toContain("per_page=");
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
    expect(allByRole(selected, "menu")).toHaveLength(0);
    expect(byRole(selected, "button", "选择《长安<&>的荔枝》").getAttribute("aria-pressed")).toBe("true");
    expect(allByRole(selected, "checkbox")).toHaveLength(0);
  });
  it("renders search/filter/sort, multi-select toolbar, native POST forms and pagination", () => {
    const html = ui.page(), root = parseHtml(html);
    for (const name of ["q", "sort", "read_filter", "page", "per_page"]) expect(byName(root, name)).toBeDefined();
    for (const hook of ["data-bulk-mode-toggle", "data-bulk-actions", "data-bulk-select-all", "data-bulk-clear", "data-bulk-done", "data-pagination-total"]) expect(byAttribute(root, hook)).toBeDefined();
    for (const action of ["/books/archive", "/books/download"]) expect(byAttribute(root, "action", action).getAttribute("method")).toBe("post");
    expect(html).toContain("归档后可在书库「已归档」中恢复"); expect(html).toContain("重新生成"); expect(byRole(byRole(root, "navigation", "阅读状态"), "link", "未读").getAttribute("aria-current")).toBe("page"); expect(byAttribute(root, "data-pagination-total").textContent).toBe("49");
    const pager = byRole(root, "navigation", "分页");
    for (const name of ["上一页", "下一页"]) expect(byRole(pager, "link", name)).toBeDefined();
    expect(pager.textContent).toContain("共 49 册");
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
    for (const hook of ["data-bulk-select-all", "data-bulk-actions", "data-bulk-clear", "data-book-ids"]) expect(allByAttribute(root, hook).length).toBeGreaterThan(0);
    expect(byAttribute(root, "data-pagination-total")).toBeDefined(); expect(root.textContent).toContain("共 49 册");
    expect(root.getElementsByTagName("img").length).toBe(0); // A generated, named cover is fine; no private image is requested.
    expect(allByRole(byAttribute(root, "data-book-card"), "link")).toHaveLength(0);
    for (const absent of ["/private-cover", "/download", "/regenerate", "批量归档", "仅看未读"]) expect(html).not.toContain(absent);
    expect(allByAttribute(root, "name", "next").every(field => field.getAttribute("value")?.startsWith("/?scope=archived"))).toBe(true);
    expect(allByRole(root, "button", "恢复").length).toBeGreaterThan(0);
    for (const action of [/\/restore$/, /\/delete$/, /^\/archive\/delete-bulk$/]) {
      const forms = allByAttribute(root, "action", action);
      expect(forms.length).toBeGreaterThan(0); for (const form of forms) expect(form.getAttribute("method")).toBe("post");
    }
    expect(html).toContain("永久删除书籍"); expect(html).toContain("无法恢复"); expect(allByRole(root, "menuitem", "恢复").length).toBeGreaterThan(0);
  });
  it("renders the selected book and current page in a library section", () => {
    const root = parseHtml(ui.section());
    expect(byAttribute(root, "id", "library-section").getAttribute("data-page")).toBe("2");
    const selection = byRole(root, "button", "选择《长安<&>的荔枝》");
    expect(selection.getAttribute("aria-pressed")).toBe("true"); expect(byAttribute(root, "data-book-card").getAttribute("data-book-id")).toBe("00" + "a".repeat(30));
  });
});
