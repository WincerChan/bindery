import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { solidOptions } from "../scripts/solid-options";
import { metadataFromDict } from "../src/core/models";
import { bookNavigation } from "../src/features/books/navigation";
import type { BookView } from "../src/server/book-view";
import type { Cases } from "./fixtures/client-rendering";
import { clientDocument, elements, fire } from "./support/client-dom";

type Probe = typeof import("./fixtures/client-rendering");
let ui: Probe, ssr: Probe, dev: Probe;
const directory = mkdtempSync(join(tmpdir(), "bindery-client-rendering-"));
const disposers: (() => void)[] = [];
function browserGlobals() {
  vi.stubGlobal("document", clientDocument());
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("scrollTo", () => {});
}
beforeEach(browserGlobals);
beforeAll(async () => {
  browserGlobals();
  const entry = resolve("tests-ts/fixtures/client-rendering.tsx");
  for (const mode of ["client", "server", "development"]) {
    const server = mode === "server", development = mode === "development";
    const result = await build({
      configFile: false, logLevel: "silent", plugins: [solid({ ...solidOptions, dev: development, hot: false })],
      // Avoid Vitest's `test` condition selecting the signals dev runtime.
      resolve: { conditions: server ? ["node", "production"] : ["browser", development ? "development" : "production"] },
      define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
      ssr: { noExternal: true },
      build: { write: false, minify: true, ...(server ? { ssr: entry } : { lib: { entry, formats: ["es" as const] } }) },
    });
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing rendering probe bundle");
    expect(chunk.imports).toEqual([]);
    const filename = join(directory, mode + ".mjs");
    writeFileSync(filename, chunk.code);
    const module: Probe = await import(/* @vite-ignore */ pathToFileURL(filename).href);
    if (server) ssr = module; else if (development) dev = module; else ui = module;
  }
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.unstubAllGlobals();
});
afterAll(() => { vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); });

function root(html?: string) {
  const node = document.createElement("div");
  if (html !== undefined) {
    node.innerHTML = html;
    vi.stubGlobal("_$HY", { r: {}, completed: new WeakSet(), events: [] });
  }
  document.documentElement.appendChild(node);
  disposers.push(() => node.remove());
  return node;
}
function mount<K extends keyof Cases>(kind: K, initial: Cases[K], hydrating = true) {
  const node = root(hydrating ? ssr.markup(kind, initial) : undefined);
  const mounted = ui.mount(node, kind, initial, hydrating);
  disposers.push(mounted.dispose);
  return { ...mounted, root: node };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const css = (node: Element, tag: string, className: string) => elements(node, tag).filter(el => el.className.split(/\s+/).includes(className));
const ids = (node: Element) => elements(node, "article", "data-book-card").map(el => el.getAttribute("data-book-id"));
const book = (id: string): BookView => ({ ...metadataFromDict({ book_id: id, title: id, updated_at: "2026-10-19", created_at: "2026-10-18" }), status_class: "ok", status_label: "完成", effective_theme_template: "default", can_regenerate: true, path: "", cover_url: null });
function library(names: string[]): Cases["library"] {
  return { books: names.map(book), total_books: names.length, page: 1, per_page: 24, total_pages: 1, sort: "updated", q: "", read_filter: "all", has_prev: false, has_next: false, prev_page: 1, next_page: 1, return_to: "/" };
}
function tracker(names: string[]): Cases["tracker"] {
  return {
    wishes: names.map(id => ({ id, title: id, author: "作者", library_book_id: null, rating: null, read: false, read_status: "unread", tags: [], tags_text: "", comment: "", book_status: "ongoing", created_at: "2026", updated_at: "2026", updated_at_display: "2026", read_status_label: "未读", book_status_label: "更新中", exists_in_library: false, exists_label: "未入库" })),
    filters: { q: "", read_filter: "all", library_filter: "all", book_status_filter: "all" }, stats: { total: names.length, filtered: names.length, read: 0, reading: 0, unread: names.length, in_library: 0, out_library: names.length }, page: 1, total_pages: 1, current_url: "/tracker", export_url: "/tracker/export", duplicate_notice: null,
  };
}
function jobs(names: string[], status = "running"): Cases["jobs"] {
  return {
    jobs: names.map(id => ({ id, book_id: id, book_title: id, book_author: "作者", can_open_book: status === "success", action_label: "重新生成", action: "regenerate", status, stage: status, rule_template: "default", message: status === "failed" ? "失败信息" : "", log: status === "failed" ? "日志" : "", created_at: "2026", updated_at: "2026" })),
    tabs: [{ key: status, label: status, count: names.length }], active_tab: status, page: 1, total_pages: 1, total_jobs: names.length, invalid_job_count: status === "failed" ? 1 : 0,
  };
}
const editor = (id: string) => ({ id, name: id, version: "1", description: "", raw: "{}", saved: false, error: null });
const detail = (): Cases["detail"] => ({ book: book("旧书名"), navigation: bookNavigation("旧书名", "/"), rules: [{ rule_id: "default", name: "默认规则", version: "1" }], themes: [{ theme_id: "default", name: "默认主题", version: "1" }], strip_original_css: false });

it.each([true, false])("updates book cards, selection and empty states (hydration=%s)", async hydrating => {
  const names = ["一", "二", "三", "四", "五", "魔临", "七", "八"];
  const mounted = mount("library", library(names), hydrating);
  await settle();
  expect(ids(mounted.root)).toEqual(names);
  const original = elements(mounted.root, "article", "data-book-card")[0]!;
  fire(elements(mounted.root, "button", "data-bulk-mode-toggle")[0]!, "click"); mounted.flush();
  expect(elements(mounted.root, "a", "data-book-detail-link")).toHaveLength(0);
  const selectAll = elements(mounted.root, "input", "data-bulk-select-all")[0] as HTMLInputElement;
  selectAll.checked = true; fire(selectAll, "change"); mounted.flush();
  expect(elements(mounted.root, "input").filter(el => el.getAttribute("name") === "book_ids")).toHaveLength(16);
  mounted.update({ ...library(["魔临"]), q: "魔临", read_filter: "unread", return_to: "/?q=魔临&read_filter=unread" });
  expect(elements(mounted.root, "span", "data-library-count")[0]!.textContent).toBe("1 册 · 仅未读");
  expect(ids(mounted.root)).toEqual(["魔临"]);
  expect(original.parentNode).toBeNull();
  expect(elements(mounted.root, "input").filter(el => el.getAttribute("name") === "book_ids").map(el => (el as HTMLInputElement).value)).toEqual(["魔临", "魔临"]);
  mounted.update(library([])); expect(ids(mounted.root)).toEqual([]); expect(mounted.root.textContent).toContain("书库还是空的");
  mounted.update(library(["二", "一"])); expect(ids(mounted.root)).toEqual(["二", "一"]);
  mounted.update(library(["一", "二"])); expect(ids(mounted.root)).toEqual(["一", "二"]);
});

it.each(["/", "/rules"])("updates actual router loader data after hydrating %s", async entry => {
  const initial = library(["甲", "魔临", "乙"]);
  const node = root(await ssr.routedMarkup(initial, entry));
  const mounted = await ui.routedLibrary(node, initial, entry, true);
  disposers.push(mounted.dispose);
  await settle();
  await mounted.update({ ...initial, q: "all" }); expect(ids(node)).toEqual(["甲", "魔临", "乙"]);
  await mounted.update({ ...library(["魔临"]), q: "魔临", return_to: "/?q=魔临" });
  expect(elements(node, "span", "data-library-count")[0]!.textContent).toBe("1 册");
  expect(ids(node)).toEqual(["魔临"]);
  await mounted.update({ ...library([]), q: "missing" }); expect(ids(node)).toEqual([]);
});

it("updates archive rows after a restore refresh, including the final empty state", () => {
  const mounted = mount("archive", [book("甲"), book("乙")]);
  mounted.update([book("乙")]);
  expect(css(mounted.root, "article", "library-archive-row").map(el => elements(el, "h2")[0]!.textContent)).toEqual(["乙"]);
  mounted.update([]); expect(css(mounted.root, "article", "library-archive-row")).toHaveLength(0);
  expect(elements(mounted.root, "button", "data-archive-select-all")).toHaveLength(0);
  expect(mounted.root.textContent).toContain("归档为空");
  mounted.update([book("甲")]); expect(css(mounted.root, "article", "library-archive-row")).toHaveLength(1);
});

it("updates tracker/wishlist filter rows and their empty state", () => {
  const mounted = mount("tracker", tracker(["甲", "乙"]));
  mounted.update(tracker(["乙"]));
  expect(css(mounted.root, "article", "catalog-tracker-row").map(el => elements(el, "h2")[0]!.textContent)).toEqual(["乙"]);
  mounted.update(tracker([])); expect(css(mounted.root, "article", "catalog-tracker-row")).toHaveLength(0);
  expect(mounted.root.textContent).toContain("没有符合筛选条件");
});

it("replaces jobs, tab counts and conditional retry/log controls for polling payloads", () => {
  const mounted = mount("jobs", jobs(["甲", "乙"]));
  mounted.update(jobs(["乙"], "failed"));
  expect(css(mounted.root, "article", "ingest-job")).toHaveLength(1);
  expect(mounted.root.textContent).toContain("failed · 1");
  expect(elements(mounted.root, "form").map(el => el.getAttribute("action"))).toContain("/jobs/%E4%B9%99/retry");
  expect(css(mounted.root, "details", "ingest-job-log")).toHaveLength(1);
  mounted.update(jobs(["乙"], "success"));
  expect(css(mounted.root, "details", "ingest-job-log")).toHaveLength(0);
  expect(mounted.root.textContent).not.toContain("一键重试");
  expect(mounted.root.textContent).toContain("打开产物");
  mounted.update(jobs([])); expect(css(mounted.root, "article", "ingest-job")).toHaveLength(0);
});

it("switches rule/theme navigation and keyed editors", () => {
  const initial: Cases["rules"] = { rules: [editor("规则甲"), editor("规则乙")], themes: [editor("主题甲")], tab: "parsing", ruleId: "规则甲", themeId: "主题甲", error: "", editor: editor("规则甲") };
  const mounted = mount("rules", initial);
  mounted.update({ ...initial, tab: "themes", editor: editor("主题甲") });
  expect(css(mounted.root, "ul", "catalog-template-list")[0]!.textContent).toBe("主题甲v1");
  expect(elements(mounted.root, "article").map(el => el.id)).toContain("theme-editor");
  expect(elements(mounted.root, "article").map(el => el.id)).not.toContain("rule-editor");
  mounted.update({ ...initial, rules: [], editor: null });
  expect(css(mounted.root, "ul", "catalog-template-list")[0]!.textContent).toBe("");
  expect(mounted.root.textContent).toContain("暂无规则模板");
});

it("replaces rule test TOCs across nonempty and empty results", () => {
  const mounted = mount("rulePreview", { volumes: 1, chapters: 2, toc: ["甲", "乙"] });
  mounted.update({ volumes: 0, chapters: 1, toc: ["丙"] });
  expect(elements(mounted.root, "li").map(el => el.textContent)).toEqual(["丙"]);
  mounted.update(null); expect(elements(mounted.root, "li")).toHaveLength(0);
  expect(mounted.root.textContent).toContain("尚未运行测试");
});

it("replaces ingest previews, duplicate fragments, TOCs and hidden upload tokens", () => {
  const preview = (filename: string): Cases["previews"][number] => ({ filename, format: "TXT", title: filename, author: "作者", volumes: 1, chapters: 2, toc: ["第一章", "第二章"], output: "book.epub", duplicates: [{ book_id: "dup", title: "重复", author: "作者", reason: "标题" }], upload_token: filename });
  const mounted = mount("previews", [preview("甲"), preview("乙")]);
  mounted.update([{ ...preview("丙"), duplicates: [], toc: [] }]);
  expect(elements(mounted.root, "article", "data-preview-filename").map(el => el.getAttribute("data-preview-filename"))).toEqual(["丙"]);
  expect(elements(mounted.root, "input").map(el => (el as HTMLInputElement).value)).toEqual(["丙"]);
  expect(elements(mounted.root, "li")).toHaveLength(0); expect(mounted.root.textContent).not.toContain("检测到疑似重复");
  mounted.update([]); expect(elements(mounted.root, "article")).toHaveLength(0);
});

it("updates pagination numbers, current links and conditional previous/next buttons", () => {
  const mounted = mount("pagination", { page: 1, total: 110, perPage: 10, href: "/?q=甲" });
  mounted.update({ page: 6, total: 110, perPage: 10, href: "/?q=乙" });
  expect(elements(mounted.root, "a").filter(el => el.hasAttribute("aria-label")).map(el => el.textContent)).toEqual(["1", "5", "6", "7", "11"]);
  expect(elements(mounted.root, "a").find(el => el.getAttribute("aria-current") === "page")!.getAttribute("href")).toBe("/?q=%E4%B9%99&page=6");
  mounted.update({ page: 1, total: 1, perPage: 10, href: "/" }); expect(elements(mounted.root, "nav")).toHaveLength(0);
});

it("switches detail/editor fragment panels and displays saved specs and cover", async () => {
  const initial = detail(), mounted = mount("detail", initial);
  fire(elements(mounted.root, "a").find(el => el.textContent === "编辑")!, "click"); mounted.flush();
  expect(css(mounted.root, "div", "books-editor")).toHaveLength(1);
  expect(css(mounted.root, "div", "books-detail")).toHaveLength(0);
  vi.stubGlobal("FormData", class extends FormData { constructor() { super(); } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ target: "/book/id", page: { ...initial, book: { ...initial.book, title: "新书名", publisher: "新出版社", cover_url: "/new-cover" } } }) }));
  fire(elements(mounted.root, "form").find(el => el.getAttribute("action")?.endsWith("/edit"))!, "submit");
  await settle(); mounted.flush();
  expect(css(mounted.root, "div", "books-editor")).toHaveLength(0);
  expect(elements(mounted.root, "h1")[0]!.textContent).toBe("新书名");
  expect(css(mounted.root, "dl", "books-spec")[0]!.textContent).toContain("新出版社");
  expect(elements(mounted.root, "img")[0]!.getAttribute("src")).toBe("/new-cover");
});

it("updates reader TOC and search result fragments, highlighting and load-more state", async () => {
  const data: Cases["reader"] = { book: { book_id: "id", title: "书名", author: "作者", cover_url: null }, sections: [{ title: "甲", item_path: "a.xhtml" }, { title: "乙", item_path: "b.xhtml" }], section_index: 0, initial_progress: null, return_to: "/" };
  const mounted = mount("reader", data);
  mounted.update({ ...data, sections: [{ title: "丙", item_path: "c.xhtml" }] });
  expect(css(mounted.root, "dialog", "reader-toc")[0]!.textContent).toContain("丙");
  expect(css(mounted.root, "dialog", "reader-toc")[0]!.textContent).not.toContain("甲");
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ query: "词", indexed_sections: 1, hits: [{ index: 0, title: "词一", snippet: "原词", offset: 0 }], has_more: true, next_offset: 1 }) });
  vi.stubGlobal("fetch", fetch);
  const input = elements(mounted.root, "input").find(el => el.getAttribute("type") === "search") as HTMLInputElement;
  const form = css(mounted.root, "form", "reader-search-form")[0]!;
  input.value = "词"; fire(input, "input"); mounted.flush(); fire(form, "submit"); await settle(); mounted.flush();
  const results = () => css(mounted.root, "ol", "reader-search-results")[0]!;
  expect(elements(results(), "li")).toHaveLength(1); expect(elements(results(), "mark").map(el => el.textContent)).toEqual(["词", "词"]);
  fetch.mockResolvedValue({ ok: true, json: async () => ({ query: "词", indexed_sections: 1, hits: [{ index: 0, title: "词二", snippet: "第二词", offset: 1 }], has_more: false }) });
  fire(elements(mounted.root, "button").find(el => el.textContent === "加载更多")!, "click"); await settle(); mounted.flush();
  expect(elements(results(), "li")).toHaveLength(2);
  expect(elements(mounted.root, "button").some(el => el.textContent === "加载更多")).toBe(false);
  fetch.mockResolvedValue({ ok: true, json: async () => ({ query: "空", indexed_sections: 1, hits: [], has_more: false }) });
  input.value = "空"; fire(input, "input"); mounted.flush(); fire(form, "submit"); await settle(); mounted.flush();
  expect(elements(results(), "li")).toHaveLength(0); expect(mounted.root.textContent).toContain("未命中");
});

it("renders route views with the development runtime and no untracked reactive reads", () => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const cases: Partial<Cases> = {
      ingest: { options: { rules: [], themes: [] }, error: "", custom_css: "p{}" },
      editor: { data: editor("规则"), kind: "rules" },
      trackerForm: { wish: tracker(["甲"]).wishes[0], next: "/tracker", onClose() {} },
      library: library(["甲"]), archive: [book("甲")], tracker: tracker(["甲"]),
      rules: { rules: [editor("甲")], themes: [], tab: "parsing", ruleId: "甲", themeId: "", error: "", editor: editor("甲") },
      rulePreview: { volumes: 0, chapters: 1, toc: ["章"] }, jobs: jobs(["甲"]), previews: [],
      detail: detail(), pagination: { page: 1, total: 20, perPage: 10, href: "/" },
      reader: { book: { book_id: "id", title: "书名", author: null, cover_url: null }, sections: [{ title: "第一章", item_path: 'Text/::|/x*y #?%.xhtml' }], section_index: 0, initial_progress: null, return_to: "/" },
    };
    for (const kind of Object.keys(cases) as (keyof Cases)[]) {
      const node = root(), mounted = dev.mount(node, kind, cases[kind]!);
      disposers.push(mounted.dispose); mounted.flush();
      if (kind === "detail") {
        fire(elements(node, "a").find(element => element.textContent === "编辑")!, "click"); mounted.flush();
      }
    }
    const reads = warnings.mock.calls.map(call => String(call[0])).filter(message => message.includes("STRICT_READ_UNTRACKED"));
    expect(reads).toEqual([]);
  } finally { warnings.mockRestore(); }
});
