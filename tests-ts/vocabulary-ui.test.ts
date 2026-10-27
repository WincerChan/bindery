import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";
import type { VocabularyItem } from "../src/server/vocabulary/query";
import { listVocabularyPage } from "../src/server/vocabulary/query";
import { syncVocabulary } from "../src/server/vocabulary/sync";
import type { LexiTraceSettingsView } from "../src/server/vocabulary/settings";
import { createBook, temporaryLibrary } from "./fixtures/library/support";
import { byLabel, byRole, parseHtml } from "./support/queries";

const bookId = (value: string) => value.repeat(32).slice(0, 32);
function item(patch: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    id: "00000000-0000-4000-8000-000000000001", word: "brag", raw_word: "brag,", lang: "en", book_id: bookId("a"), book_key: bookId("a"), book_title: "Holes",
    source_title: "Holes", device_id: "kobo-1", device_kind: "kobo", device_name: "Libra 2", looked_up_at: "2026-10-23T16:58:54.000Z",
    context: { sentence: "He likes to brag.", previous: ["Before."], following: ["After."] }, context_state: "found", push_state: "pending", push_status: null, pushed_at: null, ...patch,
  };
}
const settings = { baseUrl: "https://lexi.example", hasToken: true, enabled: true };
let ui: typeof import("./fixtures/vocabulary/ui-probe");
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: "silent", plugins: [solid({ ssr: true })], ssr: { noExternal: true }, build: { write: false, minify: false, ssr: resolve("tests-ts/fixtures/vocabulary/ui-probe.tsx") } });
  const entry = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Missing vocabulary UI SSR bundle");
  ui = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"));
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
    expect(text).toContain("重试全部失败");
    expect(text).toContain("全部设备（3）");
    expect(text).toContain("全部书籍（3）");
    expect(ui.pushStatusLabel(item())).toBe("未推送");
  });

  it("filters by device, book, push status and search text", () => {
    const a = item({ id: "a", device_id: "d1", device_name: "Libra", book_key: bookId("a"), book_title: "Alpha", word: "alpha", push_state: "pending" });
    const b = item({ id: "b", device_id: "d1", device_name: "Libra", book_key: bookId("b"), book_title: "Beta", word: "beta", push_state: "error" });
    const c = item({ id: "c", device_id: "d2", device_name: "Paperwhite", book_key: bookId("a"), book_title: "Alpha", word: "gamma", push_state: "pushed" });
    const all = [a, b, c];
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
