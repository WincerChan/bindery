import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { solidOptions } from "../scripts/solid-options";
import { clientDocument, fire } from "./support/client-dom";
import type { VocabularyApi } from "../src/features/vocabulary/vocabulary";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
import type { VocabularyItem } from "../src/server/vocabulary/query";
import { listVocabularyPage } from "../src/server/vocabulary/query";
import { syncVocabulary } from "../src/server/vocabulary/sync";
import { createBook, temporaryLibrary } from "./fixtures/library/support";
import { allByRole, byAttribute, byLabel, byRole, parseHtml } from "./support/queries";

const bookId = (value: string) => value.repeat(32).slice(0, 32);
function item(patch: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    id: "00000000-0000-4000-8000-000000000001", word: "brag", raw_word: "brag,", lang: "en", book_id: bookId("a"), book_key: bookId("a"), book_title: "Holes",
    source_title: "Holes", device_id: "kobo-1", device_kind: "kobo", device_name: "Libra 2", looked_up_at: "2026-10-23T16:58:54.000Z",
    context: { sentence: "He likes to brag.", previous: ["Before."], following: ["After."] }, context_state: "found", push_state: "pending", push_status: null, pushed_at: null, ...patch,
  };
}
const settings = { baseUrl: "https://lexi.example", hasToken: true, enabled: true };
let ui: typeof import("./fixtures/vocabulary/ui-probe"), client: typeof ui;
const disposers: (() => void)[] = [];
let browserDocument: Document;
function browserGlobals(phone = false) {
  const document = browserDocument ||= clientDocument(), body = document.createElement("body");
  document.documentElement.textContent = ""; document.documentElement.appendChild(body);
  Object.defineProperty(document, "body", { configurable: true, value: body });
  let active: Element = body;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  Object.getPrototypeOf(body).focus = function () { active = this; };
  document.addEventListener = vi.fn(); document.removeEventListener = vi.fn();
  vi.stubGlobal("document", document); vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), matchMedia: () => ({ matches: phone, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
}
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); vi.unstubAllGlobals(); });
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [solid({ ssr: true })], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/vocabulary/ui-probe.tsx") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing vocabulary UI SSR bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
  browserGlobals();
  const browser = await build({ configFile: false, logLevel: "silent", plugins: [solid({ ...solidOptions, dev: false, hot: false })], resolve: { conditions: ["browser", "production"] }, define: { "process.env.NODE_ENV": '"production"' }, build: { write: false, minify: true, lib: { entry: resolve("tests-ts/fixtures/vocabulary/ui-probe.tsx"), formats: ["es"] } } });
  const chunk = (Array.isArray(browser) ? browser : [browser]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing vocabulary client probe");
  client = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64"));
  vi.unstubAllGlobals();
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function mountPage(options: { phone?: boolean; open?: boolean; api?: Partial<VocabularyApi>; items?: VocabularyItem[] } = {}) {
  browserGlobals(options.phone);
  const data = client.dataFor(options.items ?? [item(), item({ id: "failed", word: "mortify", raw_word: "mortified", push_state: "error" }), item({ id: "conflict", word: "spleen", push_state: "conflict" })]);
  const api: VocabularyApi = { list: vi.fn(async () => data), retry: vi.fn(async () => ({ retried: 2, page: data })), saveSettings: vi.fn(async () => settings), testConnection: vi.fn(async () => ({ ok: true, status: 200, latencyMs: 12 })), ...options.api };
  const root = document.createElement("div"); document.body.appendChild(root);
  const mounted = client.mount(root, data, settings, api, options.open);
  disposers.push(mounted.dispose);
  await settle(); mounted.flush();
  return { root, api, data, ...mounted };
}

describe("生词本 client flows", () => {
  it("sends a browser-local month boundary on initial load and after retry", async () => {
    const mounted = await mountPage(), { root, api } = mounted;
    const now = new Date(), month_start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    expect(api.list).toHaveBeenCalledWith({ month_start });
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "Asia/Shanghai";
      expect(client.vocabularyMonthQuery(new Date("2026-03-17T12:00:00Z"))).toEqual({ month_start: "2026-02-28T16:00:00.000Z" });
      process.env.TZ = "America/Los_Angeles";
      expect(client.vocabularyMonthQuery(new Date("2026-03-17T12:00:00Z"))).toEqual({ month_start: "2026-03-01T08:00:00.000Z" });
    } finally { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone; }
    fire(byRole(root, "button", "全部重试"), "click"); mounted.flush();
    await settle(); mounted.flush();
    expect(api.retry).toHaveBeenCalledWith(undefined);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain("已重新排队 2 个生词");
    fire(byRole(root, "button", "重试推送 mortify"), "click"); await settle(); mounted.flush();
    expect(api.retry).toHaveBeenLastCalledWith(["failed"]);
  });

  it("filters the directory without changing the hero and resets empty results", async () => {
    const mounted = await mountPage(), { root } = mounted;
    const list = byRole(root, "list", "生词列表"), group = byRole(root, "group", "推送状态");
    fire(byRole(group, "button", "失败"), "click"); mounted.flush();
    expect(allByRole(list, "listitem")).toHaveLength(2);
    expect(byRole(group, "button", "失败").getAttribute("aria-pressed")).toBe("true");
    const search = byRole(root, "searchbox", "搜索生词、例句、书籍或设备") as HTMLInputElement;
    search.value = "mortified"; fire(search, "input"); mounted.flush();
    expect(allByRole(list, "listitem")).toHaveLength(1);
    expect(byRole(root, "heading", "已经记下 3 个词。")).toBeDefined();
    search.value = "absent"; fire(search, "input"); mounted.flush();
    expect(root.textContent).toContain("没有符合条件的生词");
    fire(allByRole(root, "button", "清除筛选")[0]!, "click"); mounted.flush();
    expect(allByRole(list, "listitem")).toHaveLength(3);
    const state = byLabel(root, "精确推送状态") as HTMLSelectElement;
    state.value = "conflict"; fire(state, "change"); mounted.flush();
    expect(allByRole(list, "listitem")).toHaveLength(1);
    expect(list.textContent).toContain("spleen");
    const book = byLabel(root, "书") as HTMLSelectElement;
    book.value = "missing"; fire(book, "change"); mounted.flush();
    expect(allByRole(list, "listitem")).toHaveLength(0);
  });

  it.each([false, true])("opens settings, tests credentials, saves and clears the write-only token (phone=%s)", async phone => {
    const mounted = await mountPage({ phone }), { root, api } = mounted;
    const opener = byRole(root, "button", "LexiTrace 设置") as HTMLButtonElement;
    opener.focus(); fire(opener, "click"); mounted.flush();
    const dialog = byRole(root, "dialog", "LexiTrace") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("data-presentation")).toBe(phone ? "bottom-sheet" : "sheet");
    const token = byLabel(dialog, /^访问令牌/) as HTMLInputElement;
    token.value = "new-secret"; fire(token, "input");
    const url = byLabel(dialog, /^LexiTrace 地址/) as HTMLInputElement;
    url.value = "https://new.example"; fire(url, "input"); mounted.flush();
    fire(byRole(dialog, "button", "测试连接"), "click"); await settle(); mounted.flush();
    expect(api.testConnection).toHaveBeenCalledWith({ baseUrl: "https://new.example", token: "new-secret" });
    expect(dialog.textContent).toContain("连接成功");
    fire(byRole(dialog, "switch", "推送生词"), "click"); mounted.flush();
    expect(byRole(dialog, "switch", "推送生词").getAttribute("aria-checked")).toBe("false");
    fire(byRole(dialog, "button", "清除令牌"), "click"); mounted.flush();
    expect(dialog.textContent).toContain("保存后将清除已保存的令牌");
    fire(byRole(dialog, "form"), "submit"); await settle(); mounted.flush();
    expect(api.saveSettings).toHaveBeenCalledWith({ baseUrl: "https://new.example", token: "new-secret", enabled: false, clearToken: true });
    expect(token.value).toBe("");
    expect(dialog.textContent).toContain("LexiTrace 设置已保存");
    fire(dialog, "keydown", { key: "Escape" }); mounted.flush();
    expect(dialog.open).toBe(false); expect(document.activeElement).toBe(opener);
  });

  it("opens deep-linked settings and cancels draft changes without saving", async () => {
    const mounted = await mountPage({ open: true }), { root, api } = mounted;
    const dialog = byRole(root, "dialog", "LexiTrace") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    const token = byLabel(dialog, /^访问令牌/) as HTMLInputElement;
    token.value = "discard-me"; fire(token, "input"); mounted.flush();
    fire(byRole(dialog, "button", "取消"), "click"); mounted.flush();
    expect(api.saveSettings).not.toHaveBeenCalled(); expect(token.value).toBe("");
    mounted.setSettingsOpen(false); mounted.flush(); mounted.setSettingsOpen(true); mounted.flush();
    expect(dialog.open).toBe(true);
  });

  it("keeps retry and settings errors visible and permits another attempt", async () => {
    const mounted = await mountPage({ api: {
      retry: vi.fn(async () => { throw new Error("推送暂不可用"); }),
      saveSettings: vi.fn(async () => { throw new Error("保存暂不可用"); }),
      testConnection: vi.fn(async () => ({ ok: false, category: "auth" as const, status: 401, latencyMs: 12 })),
    } }), { root } = mounted;
    fire(byRole(root, "button", "全部重试"), "click"); await settle(); mounted.flush();
    expect(byRole(root, "alert").textContent).toContain("推送暂不可用");
    expect(byRole(root, "button", "全部重试").hasAttribute("disabled")).toBe(false);
    fire(byRole(root, "button", "LexiTrace 设置"), "click"); mounted.flush();
    const dialog = byRole(root, "dialog", "LexiTrace");
    fire(byRole(dialog, "button", "测试连接"), "click"); await settle(); mounted.flush();
    expect(dialog.textContent).toContain("认证失败（HTTP 401）：请检查令牌");
    fire(byRole(dialog, "form"), "submit"); await settle(); mounted.flush();
    expect(byRole(dialog, "alert").textContent).toContain("保存暂不可用");
    expect(byRole(dialog, "button", "保存").hasAttribute("disabled")).toBe(false);
  });
});

describe("生词本 UI", () => {
  it("renders words, statuses, expandable context and the write-only LexiTrace settings", () => {
    const items = [
      item(),
      item({ id: "00000000-0000-4000-8000-000000000002", word: "conflict", push_state: "conflict", push_status: { http: 409, retryable: false } }),
      item({ id: "00000000-0000-4000-8000-000000000003", word: "failed", push_state: "error", push_status: { http: 503, attempts: 3, retryable: true } }),
    ];
    const html = ui.page(items, settings), root = parseHtml(html), text = root.textContent;
    expect(byRole(root, "region", "生词本")).toBeDefined();
    expect(text).toContain("brag");
    expect(text).toContain("He likes to brag.");
    expect(text).toContain("Before.");
    expect(text).toContain("After.");
    expect(text).toContain("未推送");
    expect(text).toContain("冲突");
    expect(text).toContain("失败");
    expect(text).toContain("HTTP 503");
    expect(text).toContain("已保存令牌");
    const token = byLabel(root, /^访问令牌/);
    expect(token.getAttribute("type")).toBe("password"); expect(token.getAttribute("value") ?? "").toBe("");
    expect(html).not.toContain("secret-token");
    expect(byRole(root, "button", "全部重试")).toBeDefined();
    expect(byRole(root, "button", "LexiTrace 设置")).toBeDefined();
    expect(byRole(root, "group", "推送状态")).toBeDefined();
    expect(byRole(root, "list", "生词列表")).toBeDefined();
    expect(byLabel(root, "设备")).toBeDefined();
    expect(byLabel(root, "书")).toBeDefined();
    expect(text).toContain("Libra 2（3）");
    expect(text).toContain("Holes（3）");
    expect(ui.pushStatusLabel(item())).toBe("未推送");
  });

  it("uses the unfiltered summary for the introduction and latest quotation", () => {
    const summary = ui.dataFor([item()]).summary;
    summary.total = 124;
    summary.month = { since: "2026-10-01T00:00:00.000Z", count: 38, top_source: { title: "Holes", book_id: bookId("a"), count: 30 } };
    summary.push = { pushed: 120, failed: 2, pending: 2 };
    const root = parseHtml(ui.page([item()], settings, summary));
    expect(byRole(root, "heading", "这个月查了 38 个词。")).toBeDefined();
    expect(root.textContent).toContain("生词本 · 从 Kindle 和 Kobo 同步 · 共 124 个");
    expect(root.textContent).toContain("多半来自《Holes》。");
    expect(root.textContent).toContain("LexiTrace 已推送 120 个");
    expect(root.textContent).toContain("2 个失败");
    expect(byAttribute(root, "aria-label", "最近查的").localName).toBe("figure");
    expect(root.getElementsByTagName("mark")[0]?.textContent).toBe("brag");
    expect(root.textContent).toContain("显示 1 / 124 个");
  });

  it("keeps empty and unconfigured states short and does not offer retry without failures", () => {
    const html = ui.page([], { baseUrl: "", hasToken: false, enabled: false }), root = parseHtml(html);
    expect(byRole(root, "heading", "已经记下 0 个词。")).toBeDefined();
    expect(root.textContent).toContain("生词本还是空的");
    expect(root.textContent).toContain("尚未配置 LexiTrace");
    expect(root.textContent).not.toContain("全部重试");
    expect(root.textContent).not.toContain("最近查的");
    expect(byRole(root, "button", "LexiTrace 设置")).toBeDefined();
    expect(html).not.toContain('type="checkbox"');
    expect(ui.vocabularyMonthQuery()).toEqual({});
  });

  it("highlights actual inflections safely without matching Latin substrings", () => {
    expect(ui.sentenceParts("Mortified, not mortify.", "mortified,", "mortify").filter(part => part.highlighted).map(part => part.text)).toEqual(["Mortified"]);
    expect(ui.sentenceParts("The theme", "he", "he").some(part => part.highlighted)).toBe(false);
    expect(ui.sentenceParts("<script>brag</script>", "brag,", "brag").filter(part => part.highlighted).map(part => part.text)).toEqual(["brag"]);
    expect(ui.sentenceParts("学习生词。", "（生词）。", "生词").filter(part => part.highlighted).map(part => part.text)).toEqual(["生词"]);
    expect(ui.sentenceParts("No match", "", "")).toEqual([{ text: "No match", highlighted: false }]);
  });

  it("formats lookup times in the reader's local calendar", () => {
    const now = new Date(2026, 9, 23, 12, 0);
    expect(ui.relativeLookupTime(new Date(2026, 9, 23, 11, 58).toISOString(), now)).toBe("2 分钟前");
    expect(ui.relativeLookupTime(new Date(2026, 9, 22, 21, 15).toISOString(), now)).toBe("昨天 21:15");
    expect(ui.relativeLookupTime(new Date(2026, 9, 1, 10).toISOString(), now)).toBe("10-01");
  });

  it("filters by device, book, push status and search text", () => {
    const a = item({ id: "a", device_id: "d1", device_name: "Libra", book_key: bookId("a"), book_title: "Alpha", word: "alpha", push_state: "pending" });
    const b = item({ id: "b", device_id: "d1", device_name: "Libra", book_key: bookId("b"), book_title: "Beta", word: "beta", push_state: "error" });
    const c = item({ id: "c", device_id: "d2", device_name: "Paperwhite", book_key: bookId("a"), book_title: "Alpha", word: "gamma", push_state: "pushed" });
    const all = [a, b, c];
    const conflict = item({ id: "conflict", push_state: "conflict" });
    expect(ui.filterVocabularyItems([...all, conflict], { deviceId: "all", bookId: "all", pushState: "failed", query: "" }).map(value => value.id)).toEqual(["b", "conflict"]);
    expect(ui.filterVocabularyItems([...all, conflict], { deviceId: "all", bookId: "all", pushState: "conflict", query: "" }).map(value => value.id)).toEqual(["conflict"]);
    expect(ui.filterVocabularyItems(all, { deviceId: "d1", bookId: "all", pushState: "all", query: "" }).map(value => value.id)).toEqual(["a", "b"]);
    expect(ui.filterVocabularyItems(all, { deviceId: "all", bookId: bookId("a"), pushState: "all", query: "" }).map(value => value.id)).toEqual(["a", "c"]);
    expect(ui.filterVocabularyItems(all, { deviceId: "all", bookId: "all", pushState: "error", query: "" }).map(value => value.id)).toEqual(["b"]);
    expect(ui.filterVocabularyItems(all, { deviceId: "all", bookId: "all", pushState: "all", query: "paperwhite gamma" }).map(value => value.id)).toEqual(["c"]);
    expect(ui.filterVocabularyItems(all, { deviceId: "all", bookId: "all", pushState: "all", query: "Alpha" }).map(value => value.id)).toEqual(["a", "c"]);
  });

  it("serves server-side filters and unmatched-book choices without a connected device", () => {
    const { library } = temporaryLibrary(), alpha = bookId("c"), beta = bookId("d");
    createBook(library, alpha, { title: "Alpha" }); createBook(library, beta, { title: "Beta" });
    const word = (raw: string, device: { id: string; kind: "kobo" | "kindle"; name: string }, minute: number, patch: Record<string, unknown> = {}) => ({
      lookup_id: null, raw_word: raw, word: raw, lang: "en", book_id: null, source_title: "Unknown", looked_up_at: new Date(Date.UTC(2026, 9, 23, 16, minute)).toISOString(),
      context: { sentence: `Sentence ${raw}.`, previous: [], following: [] }, ...patch,
    });
    const kobo = { id: "kobo-1", kind: "kobo" as const, name: "Libra 2" }, kindle = { id: "kindle-1", kind: "kindle" as const, name: "Paperwhite" };
    syncVocabulary(library, { device: kobo, words: [word("alpha", kobo, 1, { book_id: alpha }), word("beta", kobo, 2, { book_id: beta })] });
    syncVocabulary(library, { device: kindle, words: [word("orphan", kindle, 3, { source_title: "Unknown Book" })] });
    const failed = library.db.listVocabulary().find(row => row.word === "beta")!;
    library.db.updateVocabularyPush(failed.id, "error", JSON.stringify({ status: "error", http: 503, retryable: true }), null, failed.updated_at);
    const all = listVocabularyPage(library);
    expect(all.items.map(value => value.word).sort()).toEqual(["alpha", "beta", "orphan"]);
    expect(all.devices.map(value => value.label).sort()).toEqual(["Libra 2", "Paperwhite"]);
    expect(all.books.map(value => value.label).sort()).toEqual(["Alpha", "Beta", "Unknown Book"]);
    expect(all.totals).toEqual({ all: 3, pending: 2, pushed: 0, conflict: 0, error: 1 });
    expect(listVocabularyPage(library, { deviceId: "kobo-1" }).items.map(value => value.word).sort()).toEqual(["alpha", "beta"]);
    expect(listVocabularyPage(library, { bookId: alpha }).items.map(value => value.word)).toEqual(["alpha"]);
    expect(listVocabularyPage(library, { bookId: "title:Unknown Book" }).items.map(value => value.word)).toEqual(["orphan"]);
    expect(listVocabularyPage(library, { pushState: "error" }).items.map(value => value.word)).toEqual(["beta"]);
    expect(listVocabularyPage(library, { query: "paperwhite" }).items.map(value => value.word)).toEqual(["orphan"]);
  });
});
