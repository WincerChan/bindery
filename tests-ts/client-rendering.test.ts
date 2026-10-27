import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { mutationPlugin } from "./support/mutation-plugin";
import { securityPlugin } from "./support/security-plugin";
import { solidOptions } from "../scripts/solid-options";
import { metadataFromDict } from "../src/core/models";
import { bookNavigation } from "../src/features/books/navigation";
import { TransferQueue } from "../src/client/kindle/queue";
import type { KindleDeviceManager } from "../src/client/kindle/device";
import type { PairedDevice } from "../src/client/kindle/identity";
import type { BookView } from "../src/server/book-view";
import type { Cases } from "./fixtures/client-rendering";
import { clientDocument, elements, fire } from "./support/client-dom";

type Probe = typeof import("./fixtures/client-rendering");
let ui: Probe, ssr: Probe, dev: Probe;
const directory = mkdtempSync(join(tmpdir(), "bindery-client-rendering-"));
const disposers: (() => void)[] = [];
function browserGlobals() {
  const document = clientDocument(), body = document.createElement("body");
  document.addEventListener = vi.fn(); document.removeEventListener = vi.fn();
  body.dispatchEvent = vi.fn(() => true); Object.defineProperty(document, "body", { configurable: true, value: body });
  vi.stubGlobal("document", document);
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
      configFile: false, logLevel: "silent", plugins: [mutationPlugin(), securityPlugin(), solid({ ...solidOptions, dev: development, hot: false })],
      // Avoid Vitest's `test` condition selecting the signals dev runtime.
      resolve: { conditions: server ? ["node", "production"] : ["browser", development ? "development" : "production"] },
      define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
      ssr: { noExternal: true },
      build: { write: false, minify: true, ...(server ? { ssr: entry } : { lib: { entry, formats: ["es" as const] } }) },
    });
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing rendering probe bundle");
    expect(chunk.imports.filter(id => !server || !["node:module", "module"].includes(id))).toEqual([]);
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
  return { scope: "active", books: names.map(book), total_books: names.length, page: 1, per_page: 24, total_pages: 1, sort: "updated", q: "", read_filter: "all", has_prev: false, has_next: false, prev_page: 1, next_page: 1, return_to: "/" };
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
const detail = (): Cases["detail"] => ({ book: { ...book("旧书名"), word_count: null, file_size: null }, navigation: bookNavigation("旧书名", "/"), rules: [{ rule_id: "default", name: "默认规则", version: "1" }], themes: [{ theme_id: "default", name: "默认主题", version: "1" }], strip_original_css: false, strip_fonts: false });

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
  expect(elements(mounted.root, "span", "data-pagination-total")[0]!.textContent).toBe("1");
  expect(ids(mounted.root)).toEqual(["魔临"]);
  expect(original.parentNode).toBeNull();
  expect(elements(mounted.root, "input").filter(el => el.getAttribute("name") === "book_ids").map(el => (el as HTMLInputElement).value)).toEqual(["魔临", "魔临"]);
  mounted.update(library([])); expect(ids(mounted.root)).toEqual([]); expect(mounted.root.textContent).toContain("书库还是空的");
  mounted.update(library(["二", "一"])); expect(ids(mounted.root)).toEqual(["二", "一"]);
  mounted.update(library(["一", "二"])); expect(ids(mounted.root)).toEqual(["一", "二"]);
});

it("shows the dismissible passkey enrollment hint above the library shelves", () => {
  const mounted = mount("library", { ...library([]), passkey_prompt: true }, false);
  const hint = () => css(mounted.root, "div", "passkey-hint")[0];
  expect(hint()).toBeDefined(); expect(hint()!.textContent).toContain("添加通行密钥，下次免密码登录");
  expect(elements(hint()!, "a")[0]!.getAttribute("href")).toBe("/security");
  fire(elements(hint()!, "button")[0]!, "click"); mounted.flush();
  expect(hint()).toBeUndefined();
});

it.each(["/", "/rules"])("updates actual router loader data after hydrating %s", async entry => {
  const initial = library(["甲", "魔临", "乙"]);
  const node = root(await ssr.routedMarkup(initial, entry));
  const mounted = await ui.routedLibrary(node, initial, entry, true);
  disposers.push(mounted.dispose);
  await settle();
  await mounted.update({ ...initial, q: "all" }); expect(ids(node)).toEqual(["甲", "魔临", "乙"]);
  await mounted.update({ ...library(["魔临"]), q: "魔临", return_to: "/?q=魔临" });
  expect(elements(node, "span", "data-pagination-total")[0]!.textContent).toBe("1");
  expect(ids(node)).toEqual(["魔临"]);
  await mounted.update({ ...library([]), q: "missing" }); expect(ids(node)).toEqual([]);
});

it("updates archive rows after a restore refresh, including the final empty state", () => {
  const mounted = mount("archive", [book("甲"), book("乙")]);
  mounted.update([book("乙")]);
  expect(css(mounted.root, "article", "is-archived").map(el => elements(el, "h2")[0]!.textContent)).toEqual(["乙"]);
  mounted.update([]); expect(css(mounted.root, "article", "is-archived")).toHaveLength(0);
  expect(elements(mounted.root, "button", "data-archive-select-all")).toHaveLength(0);
  expect(mounted.root.textContent).toContain("归档为空");
  mounted.update([book("甲")]); expect(css(mounted.root, "article", "is-archived")).toHaveLength(1);
});

it("requires confirmation for single/bulk archive deletion and refreshes after bulk restore", async () => {
  Object.defineProperty(document, "body", { configurable: true, value: new EventTarget() });
  const restore = vi.fn().mockResolvedValue(undefined), refresh = vi.fn().mockResolvedValue(undefined), rpc = vi.fn().mockResolvedValue(1);
  vi.stubGlobal("__binderyTestMutation", rpc);
  const data: Cases["library"] = { ...library(["甲", "乙"]), scope: "archived", books: [book("甲"), book("乙")].map(value => ({ ...value, archived: true })), return_to: "/?scope=archived&page=2" };
  const mounted = mount("libraryActions", { data, restore, refresh, regenerate: vi.fn() }); await settle(); mounted.flush();
  const buttons = () => elements(mounted.root, "button");
  fire(buttons().find(el => el.hasAttribute("data-bulk-mode-toggle"))!, "click"); mounted.flush();
  const selectAll = elements(mounted.root, "input", "data-bulk-select-all")[0] as HTMLInputElement; selectAll.checked = true; fire(selectAll, "change"); mounted.flush();
  expect(elements(mounted.root, "strong", "data-selected-count")[0]!.textContent).toBe("2");
  for (const action of ["/book/甲/delete", "/archive/delete-bulk"]) {
    const form = elements(mounted.root, "form").find(el => el.getAttribute("action") === action) as HTMLFormElement, submit = vi.fn(); form.submit = submit;
    const prevented = vi.fn(); fire(form, "submit", { preventDefault: prevented }); mounted.flush();
    const dialog = elements(mounted.root, "dialog").find(el => el.textContent?.includes("永久删除书籍")) as HTMLDialogElement;
    expect(prevented).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled(); expect(dialog.open).toBe(true);
    const confirm = elements(dialog, "button").find(el => el.textContent === "彻底删除")!; expect(confirm.className).toContain("btn-danger");
    fire(elements(dialog, "button").find(el => el.textContent === "取消")!, "click"); mounted.flush(); expect(dialog.open).toBe(false); expect(submit).not.toHaveBeenCalled();
    rpc.mockRejectedValueOnce(new Error("删除失败"));
    fire(form, "submit"); mounted.flush(); fire(confirm, "click"); await settle(); mounted.flush();
    expect(submit).not.toHaveBeenCalled(); expect(dialog.open).toBe(true); expect(dialog.textContent).toContain("删除失败");
    fire(elements(dialog, "button").find(el => el.textContent === "彻底删除")!, "click"); await settle(); mounted.flush();
    expect(submit).not.toHaveBeenCalled(); expect(dialog.open).toBe(false);
    expect(rpc.mock.lastCall).toEqual(["mutateLibrarySelection", { data: { action: "delete", ids: action.startsWith("/book/") ? ["甲"] : ["甲", "乙"] } }]);
    selectAll.checked = true; fire(selectAll, "change"); mounted.flush();
  }
  fire(buttons().find(el => el.textContent === "恢复")!, "click"); await settle(); mounted.flush();
  expect(restore).toHaveBeenCalledExactlyOnceWith(["甲", "乙"]); expect(refresh).toHaveBeenCalledTimes(3);
  expect(elements(mounted.root, "strong", "data-selected-count")[0]!.textContent).toBe("0");
  mounted.update({ data: { ...data, scope: "active", books: data.books.map(value => ({ ...value, archived: false })) }, restore, refresh, regenerate: vi.fn() });
  expect(elements(mounted.root, "div", "data-bulk-actions")[0]!.hasAttribute("hidden")).toBe(true);
});

it("polls only visible jobs, aborts stale requests and preserves the ingest form and previews", async () => {
  vi.stubGlobal("window", {});
  let tick!: () => Promise<void>;
  const interval = vi.fn((callback: () => Promise<void>) => { tick = callback; return 42; }), clear = vi.fn();
  vi.stubGlobal("setInterval", interval); vi.stubGlobal("clearInterval", clear);
  vi.stubGlobal("FormData", class extends FormData { constructor() { super(); } });
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ filename: "selected.txt", format: "TXT", title: "预览书名", author: "作者", volumes: 0, chapters: 1, toc: ["第一章"], output: "book.epub", duplicates: [], upload_token: "token" }] });
  vi.stubGlobal("fetch", fetch);
  const initial: Cases["ingest"] = { options: { rules: [], themes: [] }, jobs: jobs(["甲"]), jobsOpen: false };
  const mounted = mount("ingest", initial); await settle(); mounted.flush();
  expect(interval).not.toHaveBeenCalled();
  const trigger = () => elements(mounted.root, "button").find(el => el.getAttribute("aria-controls") === "jobs")!;
  expect(trigger().textContent).toBe("最近任务 · 1");
  mounted.update({ ...initial, jobsOpen: true });
  expect(interval).toHaveBeenCalledWith(expect.any(Function), 5000);
  const form = elements(mounted.root, "form").find(el => el.getAttribute("action") === "/ingest")!, picker = elements(form, "input").find(el => el.getAttribute("type") === "file") as HTMLInputElement;
  const files = [new File(["正文"], "selected.txt")]; Object.defineProperty(picker, "files", { value: files });
  fire(picker, "change"); await settle(); mounted.flush();
  const cssInput = elements(form, "textarea")[0] as HTMLTextAreaElement;
  cssInput.value = "p { color: red; }"; fire(cssInput, "input"); mounted.flush();
  expect(mounted.root.textContent).toContain("预览书名");
  fetch.mockResolvedValue({ ok: true, json: async () => jobs(["新任务"], "failed") });
  await tick(); mounted.flush(); expect(mounted.root.textContent).toContain("新任务"); expect(trigger().textContent).toBe("最近任务");
  expect(elements(mounted.root, "form").find(el => el.getAttribute("action") === "/ingest")).toBe(form); expect(picker.files).toBe(files);
  expect(cssInput.value).toBe("p { color: red; }"); expect(mounted.root.textContent).toContain("预览书名");
  let resolve!: (value: unknown) => void;
  fetch.mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = tick(), signal = fetch.mock.lastCall![1].signal as AbortSignal;
  const next = { ...jobs(["当前分组"], "success"), page: 2 };
  mounted.update({ ...initial, jobs: next, jobsOpen: true }); expect(signal.aborted).toBe(true);
  resolve({ ok: true, json: async () => jobs(["过期任务"], "failed") }); await pending; mounted.flush();
  expect(mounted.root.textContent).toContain("当前分组"); expect(mounted.root.textContent).not.toContain("过期任务");
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  const count = fetch.mock.calls.length; await tick(); expect(fetch).toHaveBeenCalledTimes(count);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const last = tick(), lastSignal = fetch.mock.lastCall![1].signal as AbortSignal;
  expect(fetch.mock.lastCall![0]).toBe("/jobs/partial?tab=success&page=2");
  mounted.update({ ...initial, jobs: next, jobsOpen: false }); expect(lastSignal.aborted).toBe(true); expect(clear).toHaveBeenCalledWith(42);
  resolve({ ok: true, json: async () => next }); await last;
  expect(picker.files).toBe(files); expect(cssInput.value).toBe("p { color: red; }"); expect(mounted.root.textContent).toContain("预览书名");
  const starts = interval.mock.calls.length;
  mounted.update({ ...initial, jobs: next, jobsOpen: true }); expect(interval).toHaveBeenCalledTimes(starts + 1);
  const unmounting = tick(), unmountSignal = fetch.mock.lastCall![1].signal as AbortSignal;
  mounted.dispose(); expect(unmountSignal.aborted).toBe(true); expect(clear).toHaveBeenCalledTimes(interval.mock.calls.length);
  resolve({ ok: true, json: async () => next }); await unmounting;
});

it.each([
  ["/ingest", false], ["/ingest?jobs_tab=failed&jobs_page=2", true], ["/ingest#jobs", true], ["/ingest?jobs_page=2", false],
])("renders the URL-driven jobs sheet state for %s", async (entry, open) => {
  const initial: Cases["ingest"] = { options: { rules: [], themes: [] }, jobs: jobs(["甲", "乙"]) };
  const node = root(await ssr.routedIngestMarkup(initial, entry));
  const trigger = elements(node, "button").find(el => el.getAttribute("aria-controls") === "jobs")!;
  const sheet = elements(node, "dialog").find(el => el.id === "jobs")!;
  expect(trigger.textContent).toBe("最近任务 · 2"); expect(trigger.getAttribute("aria-expanded")).toBe(String(open));
  expect(sheet.getAttribute("data-state")).toBe(open ? "open" : "closed"); expect(sheet.className).toContain("dialog-sheet");
  expect(elements(node, "section").some(el => el.id === "jobs")).toBe(false);
});

it.each(["/ingest?jobs_tab=failed&jobs_page=2", "/ingest#jobs"])("opens direct sheet links after hydration: %s", async entry => {
  const initial: Cases["ingest"] = { options: { rules: [], themes: [] }, jobs: { ...jobs(["甲"]), tabs: [{ key: "all", label: "全部", count: 13 }, { key: "failed", label: "失败", count: 13 }], total_jobs: 13, total_pages: 2 } };
  // A real HTTP request never sends its fragment; the browser must open #jobs during hydration.
  const node = root(await ssr.routedIngestMarkup(initial, entry.split("#")[0]!));
  const mounted = await ui.routedIngest(node, initial, entry, true); disposers.push(mounted.dispose); await settle(); mounted.flush();
  const sheet = elements(node, "dialog").find(el => el.id === "jobs") as HTMLDialogElement;
  expect(sheet.open).toBe(true); expect(sheet.getAttribute("data-state")).toBe("open"); expect(mounted.href()).toBe(entry);
  const groups = elements(sheet, "nav").find(el => el.getAttribute("aria-label") === "任务分组")!;
  const current = elements(groups, "a").find(el => el.getAttribute("aria-current") === "page")!;
  if (entry.includes("failed")) expect(current.getAttribute("href")).toBe("/ingest?jobs_tab=failed&jobs_page=1#jobs");
  else expect(elements(node, "button").find(el => el.getAttribute("aria-controls") === "jobs")!.getAttribute("aria-expanded")).toBe("true");
});

it.each([true, false])("uses replace navigation to open, filter, paginate and close the jobs sheet without resetting inputs (hydration=%s)", async hydrating => {
  const initial: Cases["ingest"] = { options: { rules: [{ rule_id: "first", name: "规则一", version: "1" }, { rule_id: "second", name: "规则二", version: "1" }], themes: [] }, jobs: { ...jobs(["甲"]), tabs: [{ key: "all", label: "全部", count: 13 }, { key: "running", label: "进行中", count: 2 }, { key: "failed", label: "失败", count: 13 }], total_jobs: 13, total_pages: 2 } };
  const entry = "/ingest?keep=1";
  const node = root(hydrating ? await ssr.routedIngestMarkup(initial, entry) : undefined);
  const mounted = await ui.routedIngest(node, initial, entry, hydrating, true); disposers.push(mounted.dispose); await settle(); mounted.flush();
  const trigger = elements(node, "button").find(el => el.getAttribute("aria-controls") === "jobs")!;
  const sheet = elements(node, "dialog").find(el => el.id === "jobs") as HTMLDialogElement;
  const form = elements(node, "form").find(el => el.getAttribute("action") === "/ingest")!, cssInput = elements(form, "textarea")[0] as HTMLTextAreaElement;
  const picker = elements(form, "input").find(el => el.getAttribute("type") === "file") as HTMLInputElement, files = [new File(["正文"], "selected.txt")];
  const rule = elements(form, "select").find(el => el.getAttribute("name") === "rule_template") as HTMLSelectElement, option = elements(rule, "option")[1]!; rule.value = "second";
  Object.defineProperty(picker, "files", { value: files }); cssInput.value = "h1 { color: blue; }"; fire(cssInput, "input"); mounted.flush();
  const noPending = () => { mounted.flush(); expect(elements(node, "p").some(el => el.hasAttribute("data-route-pending"))).toBe(false); };
  const reload = async (action: () => void) => {
    const before = mounted.ingestLoads();
    action();
    await vi.waitFor(() => { mounted.flush(); expect(mounted.ingestLoads()).toBe(before + 1); });
    await new Promise(resolve => setTimeout(resolve, 0));
    noPending();
    mounted.releaseLoad();
    await vi.waitFor(() => { mounted.flush(); expect(mounted.settledLoads()).toBe(before + 1); });
    noPending();
  };
  const currentTab = () => elements(elements(sheet, "nav").find(el => el.getAttribute("aria-label") === "任务分组")!, "a").find(el => el.getAttribute("aria-current") === "page")!;
  expect(sheet.open).toBeFalsy(); await reload(() => fire(trigger, "click"));
  expect(sheet.open).toBe(true); expect(mounted.href()).toBe("/ingest?keep=1&jobs_tab=all#jobs"); expect(currentTab().textContent).toBe("全部 · 13");
  const clickJobLink = (anchor: Element) => {
    const preventDefault = vi.fn();
    fire(anchor, "click", { button: 0, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  };
  const failed = elements(sheet, "a").find(el => el.textContent === "失败 · 13")!;
  expect(failed.getAttribute("href")).toBe("/ingest?jobs_tab=failed&jobs_page=1#jobs"); await reload(() => clickJobLink(failed));
  expect(mounted.href()).toBe("/ingest?jobs_tab=failed&jobs_page=1#jobs"); expect(currentTab().textContent).toBe("失败 · 13");
  const next = elements(sheet, "a").find(el => el.textContent === "下一页")!;
  expect(next.getAttribute("href")).toBe("/ingest?jobs_tab=failed&jobs_page=2#jobs"); await reload(() => clickJobLink(next));
  expect(mounted.href()).toBe("/ingest?jobs_tab=failed&jobs_page=2#jobs");
  const pager = elements(sheet, "nav").find(el => el.getAttribute("aria-label") === "分页")!;
  expect(elements(pager, "span").find(el => el.getAttribute("aria-current") === "page")!.textContent).toBe("2");
  await reload(() => fire(elements(sheet, "button").find(el => el.getAttribute("aria-label") === "关闭最近任务")!, "click"));
  expect(mounted.href()).toBe("/ingest"); expect(sheet.open).toBe(false); expect(trigger.getAttribute("aria-expanded")).toBe("false"); expect(mounted.historyLength()).toBe(1);
  expect(currentTab().textContent).toBe("全部 · 13");
  expect(elements(node, "form").find(el => el.getAttribute("action") === "/ingest")).toBe(form); expect(picker.files).toBe(files); expect(cssInput.value).toBe("h1 { color: blue; }"); expect(rule.value).toBe("second"); expect(elements(rule, "option")[1]).toBe(option);
  await reload(() => fire(trigger, "click")); await reload(() => fire(sheet, "cancel"));
  expect(mounted.href()).toBe("/ingest"); expect(sheet.open).toBe(false);
  await reload(() => fire(trigger, "click"));
  sheet.getBoundingClientRect = vi.fn().mockReturnValue({ left: 100, right: 560, top: 0, bottom: 900 });
  await reload(() => fire(sheet, "click", { clientX: 0, clientY: 20 })); expect(mounted.href()).toBe("/ingest"); expect(sheet.open).toBe(false);
});

it("renders only four mobile tabs and all three desktop settings menu entries", async () => {
  const node = root(await ssr.routedMarkup(library([]), "/rules"));
  const dock = css(node, "nav", "tab-bar")[0]!, menu = css(node, "div", "settings-dropdown")[0]!;
  expect(elements(dock, "a").map(el => el.textContent)).toEqual(["书库", "入库", "追踪"]);
  expect(elements(dock, "button").map(el => el.textContent)).toEqual(["设置"]);
  expect(elements(dock, "a").some(el => el.getAttribute("href") === "/devices")).toBe(false);
  expect(elements(menu, "a").map(el => el.textContent)).toEqual(["规则与主题", "安全与通行密钥"]);
  expect(elements(menu, "form")[0]!.getAttribute("action")).toBe("/logout"); expect(elements(menu, "button")[0]!.textContent).toBe("退出登录");
  expect(css(node, "dialog", "more-sheet")[0]!.textContent).not.toContain("设备");
  expect(css(node, "button", "settings-toggle")[0]!.className).toContain("active");
});

it("closes the desktop settings menu on outside click, Escape, selection and route changes", async () => {
  const events = new EventTarget();
  document.addEventListener = events.addEventListener.bind(events); document.removeEventListener = vi.fn(events.removeEventListener.bind(events));
  const node = root(), mounted = await ui.routedLibrary(node, library([]), "/rules"); disposers.push(mounted.dispose); await settle();
  const gear = css(node, "button", "settings-toggle")[0] as HTMLButtonElement, focus = vi.fn(); gear.focus = focus;
  const expanded = () => gear.getAttribute("aria-expanded");
  fire(gear, "click"); mounted.flush(); expect(expanded()).toBe("true");
  const escape = new Event("keydown", { cancelable: true }); Object.defineProperty(escape, "key", { value: "Escape" }); events.dispatchEvent(escape); mounted.flush();
  expect(expanded()).toBe("false"); expect(focus).toHaveBeenCalledOnce(); expect(document.removeEventListener).toHaveBeenCalledTimes(2);
  fire(gear, "click"); mounted.flush(); events.dispatchEvent(new Event("pointerdown")); mounted.flush(); expect(expanded()).toBe("false");
  fire(gear, "click"); mounted.flush(); fire(elements(css(node, "div", "settings-dropdown")[0]!, "a")[0]!, "click"); mounted.flush(); expect(expanded()).toBe("false");
  fire(gear, "click"); mounted.flush(); await mounted.update(library([])); expect(expanded()).toBe("false");
  const mobile = elements(css(node, "nav", "tab-bar")[0]!, "button")[0]!;
  fire(mobile, "click"); mounted.flush(); expect(mobile.getAttribute("aria-expanded")).toBe("true");
  fire(elements(css(node, "dialog", "more-sheet")[0]!, "a")[0]!, "click"); mounted.flush(); expect(mobile.getAttribute("aria-expanded")).toBe("false");
});

it("shows the settings install entry for prompt-capable and iOS states, not for unavailable or standalone states", () => {
  const mounted = mount("install", { mode: null });
  expect(elements(mounted.root, "button")).toHaveLength(0);
  mounted.update({ mode: "prompt" });
  expect(elements(mounted.root, "button").map(element => element.textContent)).toEqual(["安装应用"]);
  mounted.update({ mode: "ios" });
  expect(elements(mounted.root, "button").map(element => element.getAttribute("role"))).toEqual(["menuitem"]);
  expect(mounted.root.textContent).toBe("安装应用");
  mounted.update({ mode: null });
  expect(elements(mounted.root, "button")).toHaveLength(0);
});

it("updates tracker/wishlist filter rows and their empty state", () => {
  const mounted = mount("tracker", tracker(["甲", "乙"]));
  expect(css(mounted.root, "p", "page-description")).toHaveLength(0);
  expect(css(mounted.root, "span", "pagination-summary")[0]!.textContent).toBe("1–2 / 共 2 本");
  mounted.update(tracker(["乙"]));
  expect(css(mounted.root, "div", "catalog-tracker-row").filter(el => !el.getAttribute("class")!.includes("catalog-tracker-head")).map(el => elements(el, "strong")[0]!.textContent)).toEqual(["乙"]);
  expect(css(mounted.root, "span", "pagination-summary")[0]!.textContent).toBe("1–1 / 共 1 本");
  mounted.update(tracker([])); expect(css(mounted.root, "article", "catalog-tracker-row")).toHaveLength(0);
  expect(mounted.root.textContent).toContain("没有符合筛选条件");
  expect(css(mounted.root, "span", "pagination-summary")[0]!.textContent).toBe("0 / 共 0 本");
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
  expect(mounted.root.textContent).toContain("粘贴一段文本后");
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

it("updates pagination summaries, non-link current pages and link/in-place controls", () => {
  const mounted = mount("pagination", { page: 1, total: 110, perPage: 10, href: "/?q=甲" });
  mounted.update({ page: 6, total: 110, perPage: 10, href: "/?q=乙" });
  expect(elements(mounted.root, "a").filter(el => el.hasAttribute("aria-label")).map(el => el.textContent)).toEqual(["1", "5", "7", "11"]);
  const current = elements(mounted.root, "span").find(el => el.getAttribute("aria-current") === "page")!;
  expect(current.textContent).toBe("6"); expect(css(mounted.root, "a", "pagination-control").some(el => el.getAttribute("aria-current") === "page")).toBe(false);
  mounted.update({ page: 1, total: 1, perPage: 10, href: "/" });
  expect(elements(mounted.root, "nav")).toHaveLength(1); expect(css(mounted.root, "div", "pagination-controls")).toHaveLength(0);
  expect(css(mounted.root, "span", "pagination-summary")[0]!.textContent).toBe("1–1 / 共 1 条");
  const onPage = vi.fn(), local = mount("pagination", { page: 2, total: 50, perPage: 10, onPage });
  fire(elements(local.root, "button").find(el => el.textContent === "下一页")!, "click");
  fire(elements(local.root, "button").find(el => el.getAttribute("aria-label") === "第 1 页")!, "click");
  expect(onPage.mock.calls).toEqual([[3], [1]]);
});

it("switches detail/editor fragment panels and displays saved specs and cover", async () => {
  const initial = detail(), mounted = mount("detail", initial);
  fire(elements(mounted.root, "a").find(el => el.textContent === "编辑")!, "click"); mounted.flush();
  expect(css(mounted.root, "div", "books-editor")).toHaveLength(1);
  expect(css(mounted.root, "div", "books-detail")).toHaveLength(0);
  vi.stubGlobal("FormData", class extends FormData { constructor() { super(); } });
  vi.stubGlobal("__binderyTestMutation", vi.fn().mockResolvedValue({ message: "已保存", kind: "success", page: { ...initial, book: { ...initial.book, title: "新书名", publisher: "新出版社", cover_url: "/new-cover" } } }));
  fire(elements(mounted.root, "form").find(el => el.getAttribute("action")?.endsWith("/edit"))!, "submit");
  await settle(); mounted.flush();
  expect(css(mounted.root, "div", "books-editor")).toHaveLength(0);
  expect(elements(mounted.root, "h1")[0]!.textContent).toBe("新书名");
  expect(css(mounted.root, "dl", "books-spec")[0]!.textContent).toContain("新出版社");
  expect(elements(mounted.root, "img")[0]!.getAttribute("src")).toBe("/new-cover");
});

it("uses actual Router Links across Kindle tabs without replacing the provider or interrupting a queue, and invalidates a book mutation", async () => {
  const initial = detail(), node = root(), location = { assign: vi.fn(), href: "http://bindery.local/" };
  vi.stubGlobal("location", location);
  const state = { status: "unpaired", device: null, checkedAt: null, now: 0, message: "" };
  const stop = vi.fn(), manager = { snapshot: () => state, subscribe: () => () => {}, remembered: async () => [], startMonitoring: vi.fn(() => stop) } as unknown as KindleDeviceManager;
  let finish!: (record: { filename: string; size: number }) => void, signal: AbortSignal | undefined;
  const transferBook = vi.fn(async (_device, _id, _profile, options) => { signal = options.signal; return new Promise<{ filename: string; size: number }>(resolve => { finish = resolve; }); });
  const queue = new TransferQueue({ transferBook } as never);
  const queued = queue.enqueue({ identity: { id: "kindle" } } as PairedDevice, "book");
  const mounted = await ui.spaNavigation(node, initial, tracker([]), manager, queue); disposers.push(mounted.dispose);
  await settle(); mounted.flush();
  const shell = elements(node, "div", "data-spa-shell")[0];
  const rpc = vi.fn(async (_name: string, _input: unknown) => { mounted.next({ ...initial, book: { ...initial.book, read: true } }); return { target: null }; });
  vi.stubGlobal("__binderyTestMutation", rpc);
  vi.stubGlobal("FormData", class extends FormData { constructor() { super(); } });
  fire(elements(node, "form").find(form => form.getAttribute("action")?.endsWith("/read"))!, "submit");
  await vi.waitFor(() => { mounted.flush(); expect(node.textContent).toContain("标记未读"); });
  expect(rpc).toHaveBeenCalledOnce(); expect(rpc.mock.calls[0]?.[0]).toBe("mutateBook"); expect(mounted.loads()).toBeGreaterThan(1);
  const toast = vi.mocked(document.body.dispatchEvent).mock.calls.map(([event]) => (event as CustomEvent).detail);
  expect(toast).toContainEqual({ message: "已更新阅读状态", kind: "success" });
  rpc.mockRejectedValueOnce(new Error("写入失败")); const loads = mounted.loads();
  fire(elements(node, "form").find(form => form.getAttribute("action")?.endsWith("/read"))!, "submit");
  await vi.waitFor(() => expect(vi.mocked(document.body.dispatchEvent).mock.calls.map(([event]) => (event as CustomEvent).detail)).toContainEqual({ message: "写入失败", kind: "error" }));
  expect(mounted.loads()).toBe(loads);
  await mounted.navigate("/tracker?page=3&duplicate=old"); await settle(); mounted.flush();
  vi.stubGlobal("FormData", class extends FormData { constructor() { super(); this.set("q", "中文"); this.set("read_filter", "unread"); } });
  const filter = elements(node, "form").find(form => form.getAttribute("method") === "get")!;
  expect(filter.getAttribute("action")).toBe("/tracker"); fire(filter, "submit");
  await vi.waitFor(() => { mounted.flush(); expect(mounted.href()).toBe("/tracker?q=%E4%B8%AD%E6%96%87&read_filter=unread"); });
  await mounted.navigate("/devices"); await settle(); mounted.flush();
  const provider = mounted.context(); expect(provider).toBeDefined(); expect(mounted.mounts()).toBe(1);
  const click = (text: string, modified = false) => { const preventDefault = vi.fn(); fire(elements(node, "a").find(a => a.textContent === text)!, "click", { button: 0, ctrlKey: modified, preventDefault }); return preventDefault; };
  expect(click("字体", true)).not.toHaveBeenCalled(); await settle(); expect(mounted.href()).toBe("/devices");
  for (const [text, href] of [["传书", "/devices/transfer"], ["字体", "/devices/fonts"], ["排版与预览", "/devices/preview"]]) {
    expect(click(text!)).toHaveBeenCalledOnce();
    await vi.waitFor(() => { mounted.flush(); expect(mounted.href()).toBe(href); });
    expect(mounted.context()).toBe(provider); expect(mounted.mounts()).toBe(1); expect(mounted.cleanups()).toBe(0);
    expect(elements(node, "div", "data-spa-shell")[0]).toBe(shell); expect(signal?.aborted).toBe(false); expect(stop).not.toHaveBeenCalled();
  }
  const queryLink = elements(node, "a").find(a => a.textContent === "查询与锚点")!;
  expect(queryLink.getAttribute("href")).toBe("/devices/transfer?book=a#queue");
  for (const modifier of [{ button: 1 }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    const preventDefault = vi.fn(); fire(queryLink, "click", { button: 0, ...modifier, preventDefault }); expect(preventDefault).not.toHaveBeenCalled();
  }
  click("查询与锚点"); await vi.waitFor(() => { mounted.flush(); expect(mounted.href()).toBe("/devices/transfer?book=a#queue"); });
  click("本页锚点"); await vi.waitFor(() => { mounted.flush(); expect(mounted.href()).toBe("/devices/transfer?book=a#license"); });
  expect(mounted.context()).toBe(provider); expect(mounted.cleanups()).toBe(0); expect(signal?.aborted).toBe(false);
  finish({ filename: "book.kfx", size: 1 });
  await vi.waitFor(() => expect(queue.snapshot().find(item => item.id === queued)?.state).toBe("完成"));
  expect(location.assign).not.toHaveBeenCalled(); expect(location.href).toBe("http://bindery.local/");
});

it("refreshes the real security page after passkey reauth, add, rename and manual-redirect delete without document navigation", async () => {
  let passkeys = [{ credential_id: "old-key", name: "旧名称", device_label: "设备", created_at: "2026-10-20", last_used_at: null }];
  const load = vi.fn(() => ({ passkeys: passkeys.map(key => ({ ...key })), passkey_configured: true, toast: null }));
  vi.stubGlobal("__binderyTestSecurityData", load);
  const registration = vi.fn(async () => ({ id: "new-key" })); vi.stubGlobal("__binderyTestRegistration", registration);
  const authentication = vi.fn(async () => ({ id: "old-key" })); vi.stubGlobal("__binderyTestAuthentication", authentication);
  vi.stubGlobal("location", { href: "http://localhost/security", pathname: "/security", search: "", assign: vi.fn() });
  vi.stubGlobal("window", { location, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("FormData", class extends FormData { constructor(form?: Element) { super(); if (form) for (const input of elements(form, "input")) { const name = input.getAttribute("name"); if (name) this.set(name, (input as HTMLInputElement).value); } } });
  let failDelete = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe("POST"); expect(init.credentials).toBe("same-origin");
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("reauth/passkey/options")) return Response.json({ challenge: "reauth-challenge" });
    if (url.endsWith("reauth/passkey/verify")) { expect(body.credential).toEqual({ id: "old-key" }); return Response.json({ ok: true }); }
    if (url.endsWith("register/options")) return Response.json({ challenge: "original-challenge" });
    if (url.endsWith("register/verify")) { expect(body.credential).toEqual({ id: "new-key" }); passkeys.push({ credential_id: "new-key", name: body.name, device_label: "设备", created_at: "2026-10-20", last_used_at: null }); return Response.json({ ok: true }); }
    if (url.endsWith("/rename")) { passkeys[0]!.name = body.name; return Response.json({ ok: true }); }
    if (url.endsWith("/delete")) {
      expect(init.redirect).toBe("manual"); expect(new Headers(init.headers).get("HX-Request")).toBe("true");
      if (failDelete) return Response.json({ error: "删除写入失败" }, { status: 500 });
      passkeys = passkeys.filter(key => !url.includes(key.credential_id));
      return new Response(null, { status: 303, headers: { Location: "/security?toast=deleted" } });
    }
    throw new Error("Unexpected security request: " + url);
  });
  vi.stubGlobal("fetch", fetch);
  const node = root(), mounted = await ui.securityNavigation(node); disposers.push(mounted.dispose);
  const submit = (form: Element) => { const preventDefault = vi.fn(); fire(form, "submit", { preventDefault }); mounted.flush(); expect(preventDefault).toHaveBeenCalledOnce(); };
  const clickButton = (label: string) => { const control = elements(node, "button").find(item => item.textContent === label)!; fire(control, "click"); mounted.flush(); };
  const renameForm = () => elements(node, "form").find(form => form.getAttribute("class") === "inline-form")!;
  const name = elements(node, "input").find(input => input.getAttribute("placeholder") === "例如：我的电脑") as HTMLInputElement;
  name.value = "新密钥"; fire(name, "input"); mounted.flush();
  const add = elements(node, "form").find(form => form.getAttribute("class") === "form-stack")!;
  submit(add);
  await vi.waitFor(() => { mounted.flush(); expect(load).toHaveBeenCalledTimes(2); expect(elements(node, "input").map(input => (input as HTMLInputElement).value)).toContain("新密钥"); });
  expect(name.value).toBe(""); expect(authentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "reauth-challenge" } });
  expect(registration).toHaveBeenCalledWith({ optionsJSON: { challenge: "original-challenge" } });
  const renamed = elements(renameForm(), "input")[0] as HTMLInputElement; renamed.value = "已重命名"; submit(renameForm());
  await vi.waitFor(() => { mounted.flush(); expect(load).toHaveBeenCalledTimes(3); expect((elements(renameForm(), "input")[0] as HTMLInputElement).value).toBe("已重命名"); });
  const deletion = elements(node, "form").find(form => form.getAttribute("action")?.endsWith("old-key/delete"))!;
  expect(deletion.getAttribute("method")).toBe("post");
  submit(deletion); clickButton("取消"); expect(fetch).toHaveBeenCalledTimes(5);
  failDelete = true; submit(deletion); clickButton("删除");
  await vi.waitFor(() => { mounted.flush(); expect(node.textContent).toContain("删除写入失败"); });
  expect(load).toHaveBeenCalledTimes(3); expect(elements(node, "article")).toHaveLength(2);
  failDelete = false; submit(deletion); clickButton("删除");
  await vi.waitFor(() => { mounted.flush(); expect(load).toHaveBeenCalledTimes(4); expect(elements(node, "article")).toHaveLength(1); });
  const toast = vi.mocked(document.body.dispatchEvent).mock.calls.map(([event]) => (event as CustomEvent).detail.message);
  expect(toast).toEqual(expect.arrayContaining(["已添加通行密钥", "已重命名通行密钥", "删除写入失败", "已删除通行密钥"]));
  expect(location.assign).not.toHaveBeenCalled(); expect(mounted.router.state.location.href).toBe("/security");
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/security/reauth/passkey/options", "/security/reauth/passkey/verify", "/security/passkeys/register/options", "/security/passkeys/register/verify", "/security/passkeys/old-key/rename", "/security/passkeys/old-key/delete", "/security/passkeys/old-key/delete"]);
  fetch.mockResolvedValueOnce(new Response(null, { status: 401, headers: { "HX-Redirect": "/login" } }));
  submit(renameForm());
  await vi.waitFor(() => { mounted.flush(); expect(mounted.router.state.location.href).toBe("/login?next=%2Fsecurity"); });
  expect(location.assign).not.toHaveBeenCalled();
});

it("switches security enrollment between first password setup, passkey reauth and password fallback", async () => {
  let passkeys: { credential_id: string; name: string; device_type: string | null; backed_up: number; created_at: string; last_used_at: string | null }[] = [];
  const load = vi.fn(() => ({ passkeys: passkeys.map(key => ({ ...key })), passkey_configured: true, toast: null }));
  vi.stubGlobal("__binderyTestSecurityData", load);
  vi.stubGlobal("window", { confirm: vi.fn(() => true), addEventListener() {}, removeEventListener() {} });
  const node = root(), mounted = await ui.securityNavigation(node); disposers.push(mounted.dispose); mounted.flush();
  const addForm = () => elements(node, "form").find(form => form.getAttribute("class") === "form-stack")!,
    password = () => elements(addForm(), "input").find(input => input.getAttribute("type") === "password"),
    buttons = () => elements(addForm(), "button").map(button => button.textContent);
  expect(node.textContent).toContain("首次添加需要先验证密码。");
  expect(password()).toBeDefined(); expect(buttons()).toEqual(["验证密码并添加"]);
  passkeys = [{ credential_id: "old-key", name: "旧名称", device_type: "multi_device", backed_up: 1, created_at: "2026-10-20", last_used_at: null }];
  await mounted.router.invalidate(); mounted.flush();
  expect(node.textContent).toContain("添加前请先重新验证身份。");
  expect(password()).toBeUndefined(); expect(buttons()).toEqual(["用通行密钥验证并添加", "改用密码验证"]);
  fire(elements(addForm(), "button").find(button => button.textContent === "改用密码验证")!, "click"); mounted.flush();
  expect(password()).toBeDefined(); expect(buttons()).toEqual(["验证密码并添加", "改用通行密钥验证"]);
  passkeys = [];
  await mounted.router.invalidate(); mounted.flush();
  expect(node.textContent).toContain("首次添加需要先验证密码。");
  expect(password()).toBeDefined(); expect(buttons()).toEqual(["验证密码并添加"]);
});

it.each([true, false])("ingest selection, drop, dedupe, removal and multipart submission (hydration=%s)", async hydrating => {
  // Native FormData(form) is a browser API; retain all successful text controls
  // in the node-tree DOM while using Node's real File/FormData multipart values.
  vi.stubGlobal("FormData", class extends FormData { constructor(form?: Element) {
    super(); if (!form) return;
    for (const field of [...elements(form, "input"), ...elements(form, "textarea"), ...elements(form, "select")]) {
      const name = field.getAttribute("name"), type = field.getAttribute("type");
      if (!name || type === "file" || (type === "checkbox" && !(field as HTMLInputElement).checked)) continue;
      this.append(name, (field as HTMLInputElement).value);
    }
  } });
  let version = 0, fail = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const data = init.body as FormData;
    expect(init.method).toBe("POST"); expect(data).toBeInstanceOf(FormData);
    if (url === "/ingest") return new Response(null, { headers: { "HX-Redirect": `/ingest?jobs_tab=running&toast=${encodeURIComponent("已创建任务")}&toast_kind=success#jobs` } });
    expect(url).toBe("/ingest/preview");
    if (fail) return { ok: false, status: 500 };
    version++;
    return { ok: true, json: async () => data.getAll("files").map(file => {
      const name = (file as File).name;
      return { filename: name, format: name.endsWith(".txt") ? "TXT" : "EPUB", title: name === "one.txt" ? "书名" : name, author: "作者", volumes: 1, chapters: 2, toc: ["第一章"], output: "output.epub", upload_token: `${version}-${name}`, duplicates: name === "dup.txt" ? [{ book_id: "existing", title: "已有书", author: "作者", reason: "标题" }] : [], ...(name === "bad.txt" ? { error: "文本为空" } : {}) };
    }) };
  });
  vi.stubGlobal("fetch", fetch);
  const initial: Cases["ingest"] = { options: { rules: [], themes: [] }, jobs: jobs([]) };
  const node = root(hydrating ? await ssr.routedIngestMarkup(initial, "/ingest") : undefined);
  const mounted = await ui.routedIngest(node, initial, "/ingest", hydrating); disposers.push(mounted.dispose); await settle(); mounted.flush();
  const button = () => elements(node, "button").find(el => el.getAttribute("type") === "submit") as HTMLButtonElement;
  expect(button().hasAttribute("disabled")).toBe(true); expect(node.textContent).toContain("先选择文件"); expect(node.textContent).not.toContain("没有可预览的内容");
  const picker = elements(node, "input").find(el => el.getAttribute("type") === "file") as HTMLInputElement;
  const choose = async (files: File[]) => { Object.defineProperty(picker, "files", { configurable: true, value: files }); fire(picker, "change"); await settle(); mounted.flush(); };
  const one = new File(["正文"], "one.txt");
  const openPicker = vi.fn(); picker.click = openPicker;
  fire(css(node, "label", "ingest-dropzone")[0]!, "keydown", { key: "Enter" }); expect(openPicker).toHaveBeenCalledOnce();
  Object.defineProperty(picker, "files", { configurable: true, value: [one] }); fire(picker, "change"); mounted.flush();
  expect(button().hasAttribute("disabled")).toBe(true); expect(node.textContent).toContain("正在解析…");
  await settle(); mounted.flush(); expect(button().textContent).toBe("开始入库 · 1 本"); expect(button().hasAttribute("disabled")).toBe(false); expect(node.textContent).toContain("已选 1 个文件");
  const override = elements(node, "input").find(el => el.getAttribute("name") === "title") as HTMLInputElement;
  expect(override.value).toBe("书名"); override.value = "覆盖书名"; fire(override, "input"); mounted.flush();
  expect(elements(node, "input").some(el => el.getAttribute("name") === "author")).toBe(true);
  await choose([one]); expect(fetch).toHaveBeenCalledTimes(1); expect(override.value).toBe("覆盖书名");
  const zone = css(node, "label", "ingest-dropzone")[0]!;
  fire(zone, "dragover"); mounted.flush(); expect(zone.className).toContain("is-dragging");
  fire(zone, "dragleave", { relatedTarget: null }); mounted.flush(); expect(zone.className).not.toContain("is-dragging");
  fire(zone, "drop", { dataTransfer: { files: [one, new File(["dup"], "dup.txt"), new File([""], "bad.txt"), new File(["no"], "image.png")] } });
  await settle(); mounted.flush();
  expect(node.textContent).toContain("不支持的文件类型"); expect(node.textContent).toContain("已选 3 个文件"); expect(button().textContent).toBe("开始入库 · 2 本");
  expect(node.textContent).toContain("1 本疑似重复：不勾选「仍然新建」将归入已有书籍"); expect(node.textContent).toContain("仍然新建一本"); expect(node.textContent).toContain("文本为空");
  expect(elements(node, "input").filter(el => el.getAttribute("name") === "upload_tokens").map(el => (el as HTMLInputElement).value)).toEqual(["2-one.txt", "2-dup.txt"]);
  expect(elements(node, "input").some(el => el.getAttribute("name") === "title")).toBe(false);
  // Removal restages the remaining files; no removed/failed/obsolete token leaks.
  fire(elements(node, "button").find(el => el.getAttribute("aria-label") === "移除 one.txt")!, "click"); await settle(); mounted.flush();
  expect((fetch.mock.lastCall![1].body as FormData).getAll("files").map(file => (file as File).name)).toEqual(["dup.txt", "bad.txt"]);
  expect(button().textContent).toBe("开始入库 · 1 本");
  const keep = elements(node, "input").find(el => el.getAttribute("name") === "dedupe_keep_tokens") as HTMLInputElement; keep.checked = true;
  const form = elements(node, "form").find(el => el.getAttribute("action") === "/ingest")!;
  fire(form, "submit"); mounted.flush(); expect(button().hasAttribute("disabled")).toBe(true); expect(node.textContent).toContain("正在提交…"); await settle(); mounted.flush();
  const sent = fetch.mock.calls.find(([url]) => url === "/ingest")![1];
  expect(sent.headers).toEqual({ Accept: "application/json", "HX-Request": "true" });
  const data = sent.body as FormData;
  expect(data.getAll("files")).toEqual([]); expect(data.getAll("upload_tokens")).toEqual(["3-dup.txt"]); expect(data.getAll("dedupe_keep_tokens")).toEqual(["3-dup.txt"]); expect(data.get("dedupe_mode")).toBe("normalize");
  expect(mounted.href()).toBe("/ingest?jobs_tab=running#jobs"); expect((elements(node, "dialog").find(el => el.id === "jobs") as HTMLDialogElement).open).toBe(true);
  expect(vi.mocked(document.body.dispatchEvent).mock.calls.map(([event]) => (event as CustomEvent).detail).filter(value => value?.message === "已创建任务")).toHaveLength(1);
  expect(button().hasAttribute("disabled")).toBe(true);
  fail = true; await choose([one]); expect(node.textContent).toContain("预览解析失败"); expect(button().hasAttribute("disabled")).toBe(true);
  fail = false; fire(elements(node, "button").find(el => el.textContent === "重新解析")!, "click"); await settle(); mounted.flush(); expect(button().hasAttribute("disabled")).toBe(false);
  fire(elements(node, "button").find(el => el.getAttribute("aria-label") === "移除 one.txt")!, "click"); await settle(); mounted.flush(); expect(button().hasAttribute("disabled")).toBe(true); expect(node.textContent).toContain("先选择文件");
  await choose([one]);
  for (const [name, value] of [["title", "覆盖标题"], ["author", "覆盖作者"]]) { const field = elements(node, "input").find(el => el.getAttribute("name") === name) as HTMLInputElement; field.value = value!; fire(field, "input"); }
  mounted.flush(); fire(form, "submit"); await settle(); mounted.flush();
  const last = fetch.mock.calls.filter(([url]) => url === "/ingest").at(-1)![1].body as FormData;
  expect(last.get("title")).toBe("覆盖标题"); expect(last.get("author")).toBe("覆盖作者"); expect(last.get("dedupe_mode")).toBe("keep"); expect(last.getAll("files")).toEqual([]);
});

it.each(["archive", "restore", "delete"] as const)("refreshes library %s through RPC without losing archived/search state", async action => {
  const archived = action !== "archive", entry = `/?scope=${archived ? "archived" : "active"}&q=%E4%B9%A6&page=2&sort=created&per_page=4`;
  const initial = { ...library(["甲", "乙"]), scope: archived ? "archived" as const : "active" as const, q: "书", page: 2, books: [book("甲"), book("乙")].map(b => ({ ...b, archived })), return_to: entry };
  const node = root(), mounted = await ui.navigationWorkspace(node, initial, { options: { rules: [], themes: [] }, jobs: jobs([]) }, entry); disposers.push(mounted.dispose); await settle(); mounted.flush();
  vi.stubGlobal("location", { assign: vi.fn(), href: "http://bindery.local" + entry });
  const rpc = vi.fn(async () => { mounted.nextLibrary({ ...initial, books: [], total_books: 0 }); return 2; }); vi.stubGlobal("__binderyTestMutation", rpc);
  const single = elements(node, "form").find(el => el.getAttribute("action") === `/book/甲/${action}`)!;
  const submit = vi.fn(); (single as HTMLFormElement).submit = submit;
  fire(single, "submit"); mounted.flush();
  if (action !== "restore") { const dialog = elements(node, "dialog").find(el => (el as HTMLDialogElement).open)!; fire(elements(dialog, "button").find(el => el.textContent === (action === "delete" ? "彻底删除" : "归档"))!, "click"); }
  await vi.waitFor(() => { mounted.flush(); expect(ids(node)).toEqual([]); });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("mutateLibrarySelection", { data: { action, ids: ["甲"] } }); expect(mounted.libraryLoads()).toBe(2); expect(mounted.href()).toBe(entry); expect(submit).not.toHaveBeenCalled();
  mounted.nextLibrary(initial); await mounted.router.invalidate(); mounted.flush();
  fire(elements(node, "button", "data-bulk-mode-toggle")[0]!, "click"); mounted.flush();
  const all = elements(node, "input", "data-bulk-select-all")[0] as HTMLInputElement; all.checked = true; fire(all, "change"); mounted.flush();
  if (action === "restore") fire(elements(node, "button").find(el => el.textContent === "恢复")!, "click");
  else { fire(elements(node, "form").find(el => el.getAttribute("action") === (action === "archive" ? "/books/archive" : "/archive/delete-bulk"))!, "submit"); mounted.flush(); const dialog = elements(node, "dialog").find(el => (el as HTMLDialogElement).open)!; fire(elements(dialog, "button").find(el => el.textContent === (action === "archive" ? "归档" : "彻底删除"))!, "click"); }
  await vi.waitFor(() => { mounted.flush(); expect(ids(node)).toEqual([]); });
  expect(rpc.mock.lastCall).toEqual(["mutateLibrarySelection", { data: { action, ids: ["甲", "乙"] } }]); expect(mounted.href()).toBe(entry); expect(mounted.libraryLoads()).toBe(4); expect(location.assign).not.toHaveBeenCalled();
});

it("refreshes retry/cleanup in the open sheet and Router-navigates shell, pagination, cards and regenerate", async () => {
  const initial = { ...library(["甲"]), total_books: 25, total_pages: 2 };
  const ingest: Cases["ingest"] = { options: { rules: [], themes: [] }, jobs: jobs(["failed-job"], "failed") };
  const regenerate = vi.fn(async () => ({ queued: 2, failed: 1, skipped: 0 })), node = root();
  const mounted = await ui.navigationWorkspace(node, initial, ingest, "/", regenerate); disposers.push(mounted.dispose); await settle(); mounted.flush();
  vi.stubGlobal("location", { assign: vi.fn() });
  const click = async (anchor: Element) => { const preventDefault = vi.fn(); fire(anchor, "click", { button: 0, preventDefault }); expect(preventDefault).toHaveBeenCalledOnce(); await settle(); mounted.flush(); };
  const pager = elements(node, "nav").find(el => el.getAttribute("aria-label") === "分页")!;
  await click(elements(pager, "a").find(el => el.textContent === "下一页")!); expect(mounted.href()).toBe("/?page=2");
  const card = elements(node, "a", "data-book-detail-link")[0]!, href = card.getAttribute("href"); await click(card); expect(mounted.href()).toBe(href);
  await click(css(node, "a", "brand")[0]!); expect(mounted.href()).toBe("/");
  fire(elements(node, "button", "data-bulk-mode-toggle")[0]!, "click"); mounted.flush(); const all = elements(node, "input", "data-bulk-select-all")[0] as HTMLInputElement; all.checked = true; fire(all, "change"); mounted.flush();
  fire(elements(node, "button").find(el => el.textContent === "重新生成")!, "click");
  await vi.waitFor(() => { mounted.flush(); expect((elements(node, "dialog").find(el => el.id === "jobs") as HTMLDialogElement).open).toBe(true); });
  expect(regenerate).toHaveBeenCalledExactlyOnceWith(["甲"]); expect(mounted.href()).toBe("/ingest?jobs_tab=running#jobs");
  await mounted.router.navigate({ href: "/ingest?jobs_tab=failed&jobs_page=2#jobs" }); mounted.flush();
  const rpc = vi.fn(async (name: string) => { mounted.nextIngest(name === "cleanupInvalidJobs" ? { ...ingest, jobs: { ...jobs([]), invalid_job_count: 0 } } : { ...ingest, jobs: jobs(["retried"], "failed") }); return {}; }); vi.stubGlobal("__binderyTestMutation", rpc);
  const loads = mounted.ingestLoads();
  fire(elements(node, "form").find(el => el.getAttribute("action") === "/jobs/failed-job/retry")!, "submit");
  await vi.waitFor(() => { mounted.flush(); expect(node.textContent).toContain("retried"); }); expect(mounted.ingestLoads()).toBe(loads + 1);
  fire(elements(node, "form").find(el => el.getAttribute("action") === "/jobs/cleanup-invalid")!, "submit");
  await vi.waitFor(() => { mounted.flush(); expect(node.textContent).toContain("暂无任务"); });
  expect(rpc.mock.calls).toEqual([["retryJob", { data: "failed-job" }], ["cleanupInvalidJobs", { data: "failed" }]]); expect(mounted.href()).toBe("/ingest?jobs_tab=failed&jobs_page=2#jobs"); expect((elements(node, "dialog").find(el => el.id === "jobs") as HTMLDialogElement).open).toBe(true);
  await click(css(node, "a", "nav-link").find(el => el.textContent === "书库")!); expect(mounted.href()).toBe("/");
  fire(css(node, "button", "settings-toggle")[0]!, "click"); mounted.flush(); await click(elements(css(node, "div", "settings-dropdown")[0]!, "a")[0]!); expect(mounted.href()).toBe("/rules");
  const mobile = css(node, "nav", "tab-bar")[0]!; await click(elements(mobile, "a").find(el => el.textContent === "入库")!); expect(mounted.href()).toBe("/ingest");
  expect(location.assign).not.toHaveBeenCalled();
});

it.each(["archive", "restore", "delete", "regenerate", "retry", "cleanup"])("Router-redirects an expired %s mutation to login", async action => {
  const entry = action === "retry" || action === "cleanup" ? "/ingest?jobs_tab=failed#jobs" : "/?scope=archived&q=保留";
  const initial = { ...library(["甲"]), scope: "archived" as const, books: [{ ...book("甲"), archived: true }], return_to: entry };
  const denied = async () => { throw ui.loginRedirect(entry); };
  const node = root(), mounted = await ui.navigationWorkspace(node, initial, { options: { rules: [], themes: [] }, jobs: jobs(["job"], "failed") }, entry, denied); disposers.push(mounted.dispose); await settle(); mounted.flush();
  vi.stubGlobal("__binderyTestMutation", denied); vi.stubGlobal("location", { assign: vi.fn() });
  if (action === "regenerate" || action === "archive") {
    mounted.nextLibrary({ ...initial, scope: "active", books: [{ ...book("甲"), archived: false }] }); await mounted.router.invalidate(); mounted.flush();
  }
  if (action === "regenerate") { fire(elements(node, "button", "data-bulk-mode-toggle")[0]!, "click"); mounted.flush(); const all = elements(node, "input", "data-bulk-select-all")[0] as HTMLInputElement; all.checked = true; fire(all, "change"); mounted.flush(); fire(elements(node, "button").find(el => el.textContent === "重新生成")!, "click"); }
  else {
    const path = action === "retry" ? "/jobs/job/retry" : action === "cleanup" ? "/jobs/cleanup-invalid" : `/book/甲/${action}`;
    fire(elements(node, "form").find(el => el.getAttribute("action") === path)!, "submit"); mounted.flush();
    if (action === "archive" || action === "delete") { const dialog = elements(node, "dialog").find(el => (el as HTMLDialogElement).open)!; fire(elements(dialog, "button").find(el => el.textContent === (action === "archive" ? "归档" : "彻底删除"))!, "click"); }
  }
  await vi.waitFor(() => { mounted.flush(); expect(mounted.href()).toBe(`/login?next=${encodeURIComponent(entry)}`); }); expect(location.assign).not.toHaveBeenCalled();
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
