import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import type { VocabularyRow } from "../src/server/db";
import { listVocabularyPage, vocabularyQuery } from "../src/server/vocabulary/query";
import { syncVocabulary } from "../src/server/vocabulary/sync";
import { createBook, temporaryLibrary } from "./fixtures/library/support";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const { root, library } = temporaryLibrary();
  roots.push(root);
  const add = (id: string, patch: Partial<VocabularyRow> = {}) => {
    const row: VocabularyRow = {
      id, device_id: "kobo-1", device_kind: "kobo", device_name: "Libra 2", word: id, raw_word: `${id},`, lang: "en",
      book_id: null, source_title: "Pride and Prejudice", looked_up_at: "2026-03-01T00:00:00.000Z",
      device_context_json: null, context_json: null, context_state: "pending", push_state: "pending", push_status_json: null,
      pushed_at: null, created_at: "2026-04-01T00:00:00.000Z", updated_at: "2026-04-01T00:00:00.000Z", ...patch,
    };
    library.db.upsertVocabulary(row);
    return row;
  };
  return { library, add };
}
const month_start = "2026-03-01T00:00:00.000Z";
const invalidStarts = [null, 123, {}, [], "", "yesterday", "2026-03-01", "2026-03-01T00:00:00", "2026-02-30T00:00:00Z",
  "2025-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-03-01T24:00:00Z",
  "1900-02-29T00:00:00Z", "2026-02-30T00:30:00+14:00", "2025-02-29T23:30:00-12:00",
  "2026-03-01T00:60:00Z", "2026-03-01T00:00:60Z", "2026-03-01T00:00:00+24:00", "2026-03-01T00:00:00+08:60",
  " 2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z' OR 1=1 --", "x".repeat(1000)];

describe("vocabulary summary input", () => {
  it.each([
    ["2026-03-01T00:00:00Z", month_start],
    ["2026-03-01T00:00:00+08:00", "2026-02-28T16:00:00.000Z"],
    ["2026-03-01T00:00:00-05:00", "2026-03-01T05:00:00.000Z"],
    ["2024-02-29T12:34:56.789Z", "2024-02-29T12:34:56.789Z"],
    ["2000-02-29T00:30:00+14:00", "2000-02-28T10:30:00.000Z"],
    ["2024-02-29T23:30:00-12:00", "2024-03-01T11:30:00.000Z"],
  ])("normalizes a timezone-qualified instant %s", (value, expected) => {
    expect(vocabularyQuery({ month_start: value })).toEqual({ month_start: expected });
  });

  it("ignores invalid instants rather than accepting permissive Date.parse formats", () => {
    for (const value of invalidStarts) expect(vocabularyQuery({ month_start: value })).toEqual({});
    expect(vocabularyQuery({ month_start: undefined })).toEqual({});
    expect(vocabularyQuery({ month_start, ignored: true })).toEqual({ month_start });
  });

  it("preserves the existing filter validator and its errors", () => {
    expect(vocabularyQuery({ deviceId: "kobo-1", bookId: "title:Book", pushState: "error", query: "word", month_start })).toEqual({
      deviceId: "kobo-1", bookId: "title:Book", pushState: "error", query: "word", month_start,
    });
    for (const value of [[], 42, { deviceId: "../bad" }, { bookId: "b".repeat(301) }, { pushState: "failed" }, { query: "q".repeat(201) }]) {
      expect(() => vocabularyQuery(value)).toThrow("生词筛选条件无效");
    }
  });
});

describe("vocabulary summary", () => {
  it("returns zeros and nulls for an empty database", () => {
    const { library } = setup();
    expect(listVocabularyPage(library, { month_start }).summary).toEqual({
      total: 0, month: { since: month_start, count: 0, top_source: null },
      push: { pushed: 0, failed: 0, pending: 0 }, latest: null,
    });
  });

  it("uses the user's local month boundary inclusively, preserving milliseconds", () => {
    const { library, add } = setup();
    add("before", { looked_up_at: "2026-02-28T15:59:59.999Z" });
    add("boundary", { looked_up_at: "2026-02-28T16:00:00.000Z" });
    add("after", { looked_up_at: "2026-02-28T16:00:00.001Z" });
    expect(listVocabularyPage(library, { month_start: "2026-03-01T00:00:00+08:00" }).summary).toMatchObject({
      total: 3, month: { since: "2026-02-28T16:00:00.000Z", count: 2, top_source: { title: "Pride and Prejudice", book_id: null, count: 2 } },
      latest: { id: "after" },
    });
    expect(listVocabularyPage(library, { month_start }).summary.month).toEqual({ since: month_start, count: 0, top_source: null });
  });

  it("falls back to the server-local start of this month for absent or invalid input", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-03-01T00:30:00.000Z"));
    const { library, add } = setup(), now = new Date(), boundary = new Date(now.getFullYear(), now.getMonth(), 1);
    add("before", { looked_up_at: new Date(boundary.getTime() - 1).toISOString() });
    add("boundary", { looked_up_at: boundary.toISOString() });
    for (const input of [undefined, {}, ...invalidStarts.map(month_start => ({ month_start }))]) {
      expect(listVocabularyPage(library, input).summary.month).toEqual({
        since: boundary.toISOString(), count: 1, top_source: { title: "Pride and Prejudice", book_id: null, count: 1 },
      });
    }
  });

  it("ranks sources by monthly lookup count, then their most recent lookup", () => {
    const { library, add } = setup(), book_id = "a".repeat(32);
    add("a1", { source_title: "Alpha", looked_up_at: "2026-03-02T00:00:00.000Z" });
    add("a2", { source_title: "Alpha", looked_up_at: "2026-03-03T00:00:00.000Z" });
    add("b1", { source_title: "Beta", book_id, looked_up_at: "2026-03-01T00:00:00.000Z" });
    add("b2", { source_title: "Beta", book_id, looked_up_at: "2026-03-03T00:00:00.001Z" });
    add("old1", { source_title: "Alpha", looked_up_at: "2026-02-28T00:00:00.000Z" });
    add("old2", { source_title: "Alpha", looked_up_at: "2026-02-28T00:00:00.001Z" });
    add("newest", { source_title: "Gamma", looked_up_at: "2026-03-04T00:00:00.000Z" });
    expect(listVocabularyPage(library, { month_start }).summary.month.top_source).toEqual({ title: "Beta", book_id, count: 2 });
    add("a3", { source_title: "Alpha" });
    expect(listVocabularyPage(library, { month_start }).summary.month.top_source).toEqual({ title: "Alpha", book_id: null, count: 3 });
  });

  it("keeps distinct book IDs and unmatched titles separate, with deterministic exact ties", () => {
    const { library, add } = setup();
    add("matched-a", { book_id: "a".repeat(32), source_title: "Same title" });
    add("matched-b", { book_id: "b".repeat(32), source_title: "Same title" });
    add("unmatched", { source_title: "Same title" });
    add("other", { source_title: "Another title" });
    expect(listVocabularyPage(library, { month_start }).summary.month.top_source).toEqual({ title: "Another title", book_id: null, count: 1 });
  });

  it("groups monthly sources by the book filter key and resolves the winning display title", () => {
    const { library, add } = setup(), book_id = "a".repeat(32);
    createBook(library, book_id, { title: "Library title" });
    add("kindle", { book_id, source_title: "Kindle title", device_kind: "kindle" });
    add("kobo", { book_id, source_title: "Kobo title" });
    add("renamed", { book_id, source_title: "Old library title" });
    add("rival1", { source_title: "Rival", looked_up_at: "2026-03-02T00:00:00.000Z" });
    add("rival2", { source_title: "Rival", looked_up_at: "2026-03-03T00:00:00.000Z" });
    add("unmatched", { source_title: "Library title" });
    const page = listVocabularyPage(library, { month_start }), top = page.summary.month.top_source!;
    expect(top).toEqual({ title: "Library title", book_id, count: 3 });
    expect(page.books.find(book => book.key === book_id)).toEqual({ key: book_id, label: top.title, count: top.count });
    expect(page.books.find(book => book.key === "title:Library title")).toEqual({ key: "title:Library title", label: "Library title", count: 1 });
    const filtered = listVocabularyPage(library, { month_start, bookId: book_id });
    expect(filtered.items).toHaveLength(top.count);
    expect(filtered.items.every(item => item.book_key === book_id && item.book_title === top.title)).toBe(true);
    expect(filtered.summary).toEqual(page.summary);
  });

  it("uses the list's cached fallback title when linked metadata is missing", () => {
    const { library, add } = setup(), book_id = "a".repeat(32);
    add("older", { book_id, source_title: "Old device title" });
    add("latest", { book_id, source_title: "Recent device title", looked_up_at: "2026-03-02T00:00:00.000Z" });
    const metadata = vi.spyOn(library, "loadMetadata"), page = listVocabularyPage(library, { month_start });
    expect(page.summary.latest?.book_title).toBe(page.items[0]!.book_title);
    expect(page.summary.month.top_source).toEqual({ title: "Recent device title", book_id, count: 2 });
    expect(page.books).toEqual([{ key: book_id, label: "Recent device title", count: 2 }]);
    expect(metadata).toHaveBeenCalledTimes(1);
  });

  it("maps saved/queued/deleted to pushed, all errors and conflicts to failed, and unknown states to pending", () => {
    const { library, add } = setup();
    for (const [status, http] of [["saved", 200], ["queued", 202], ["deleted", 410]] as const) {
      add(status, { push_state: "pushed", push_status_json: JSON.stringify({ status, http }) });
    }
    add("conflict", { push_state: "conflict", push_status_json: JSON.stringify({ http: 409, retryable: false }) });
    add("transient", { push_state: "error", push_status_json: JSON.stringify({ http: 503, retryable: true }) });
    add("permanent", { push_state: "error", push_status_json: JSON.stringify({ http: 401, retryable: false }) });
    add("pending"); add("unknown", { push_state: "unexpected" });
    expect(listVocabularyPage(library, { month_start }).summary.push).toEqual({ pushed: 3, failed: 3, pending: 2 });
  });

  it("selects latest by lookup time, not sync time, and reuses list context parsing", () => {
    const { library, add } = setup(), book_id = "a".repeat(32);
    add("older", { created_at: "2027-01-01T00:00:00.000Z", updated_at: "2027-01-01T00:00:00.000Z" });
    const latest = add("latest", {
      looked_up_at: "2026-03-02T00:00:00.000Z", book_id, device_name: "Paperwhite", device_kind: "kindle",
      context_json: JSON.stringify({ sentence: "The latest word.", previous: ["Before.", 123], following: [false, "After."], offset: 12 }),
    });
    const page = listVocabularyPage(library, { month_start });
    expect(page.summary.latest).toEqual({
      id: latest.id, word: latest.word, raw_word: latest.raw_word, book_title: latest.source_title, book_id,
      device_name: "Paperwhite", looked_up_at: latest.looked_up_at,
      context: { sentence: "The latest word.", previous: ["Before."], following: ["After."] },
    });
    expect(page.summary.latest!.context).toEqual(page.items.find(item => item.id === latest.id)!.context);
    for (const context_json of [null, "broken JSON", "null", "{}"]) {
      add("latest", { ...latest, context_json });
      // Context is frozen by upsert; update directly to exercise legacy/malformed rows.
      library.db.run("UPDATE vocabulary SET context_json = ? WHERE id = ?", context_json, latest.id);
      const result = listVocabularyPage(library, { month_start });
      expect(result.summary.latest!.context).toEqual({ sentence: "", previous: [], following: [] });
      expect(result.summary.latest!.context).toEqual(result.items[0]!.context);
    }
  });

  it("presents latest through the list view with the resolved library title and shared cache", () => {
    const { library, add } = setup(), book_id = "a".repeat(32);
    createBook(library, book_id, { title: "Resolved library title" });
    add("latest", {
      book_id, source_title: "Stored device title",
      context_json: JSON.stringify({ sentence: "The latest word.", previous: ["Before.", 42], following: ["After."] }),
    });
    const metadata = vi.spyOn(library, "loadMetadata"), page = listVocabularyPage(library, { month_start });
    const item = page.items[0]!;
    expect(item.source_title).toBe("Stored device title");
    expect(item.book_title).toBe("Resolved library title");
    expect(page.summary.latest).toEqual({
      id: item.id, word: item.word, raw_word: item.raw_word, book_title: item.book_title, book_id: item.book_id,
      device_name: item.device_name, looked_up_at: item.looked_up_at, context: item.context,
    });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(listVocabularyPage(library, { month_start, query: "no-match" }).summary.latest).toEqual(page.summary.latest);
  });

  it("breaks identical latest timestamps by ID, like the existing list", () => {
    const { library, add } = setup();
    add("z"); add("a");
    expect(listVocabularyPage(library, { month_start }).summary.latest?.id).toBe("a");
  });

  it("is independent of every list filter", () => {
    const { library, add } = setup();
    add("first"); add("latest", { device_id: "kindle-1", push_state: "error", looked_up_at: "2026-03-02T00:00:00.000Z" });
    const summary = listVocabularyPage(library, { month_start }).summary;
    for (const filter of [{ deviceId: "missing" }, { bookId: "title:Missing" }, { pushState: "pushed" }, { query: "no-match" }]) {
      const page = listVocabularyPage(library, { month_start, ...filter });
      expect(page.items).toEqual([]);
      expect(page.summary).toEqual(summary);
    }
  });

  it("aggregates every row even beyond the list's 50,000-row limit", () => {
    const { library, add } = setup(), seed = add("seed");
    const columns = Object.keys(seed);
    library.db.run(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 50000)
      INSERT INTO vocabulary (${columns.join(", ")})
      SELECT printf('bulk-%05d', n), ${columns.slice(1).map(column => `v.${column}`).join(", ")}
      FROM numbers CROSS JOIN vocabulary v WHERE v.id = 'seed'`);
    const page = listVocabularyPage(library, { month_start });
    expect(page.items).toHaveLength(50000);
    expect(page.summary).toMatchObject({ total: 50001, month: { count: 50001, top_source: { count: 50001 } }, push: { pending: 50001 } });
  });

  it("normalizes both device sync inputs before indexed timestamp comparisons", () => {
    const { library } = setup();
    for (const [kind, looked_up_at] of [["kindle", "2026-03-01T00:00:00+08:00"], ["kobo", "2026-02-28T15:59:59.999Z"]] as const) {
      syncVocabulary(library, {
        device: { id: kind, kind, name: kind }, words: [{ raw_word: kind, source_title: "Book", looked_up_at }],
      });
    }
    expect(library.db.listVocabulary().map(row => row.looked_up_at)).toEqual(["2026-02-28T16:00:00.000Z", "2026-02-28T15:59:59.999Z"]);
    expect(listVocabularyPage(library, { month_start: "2026-03-01T00:00:00+08:00" }).summary).toMatchObject({
      total: 2, month: { count: 1 }, latest: { word: "kindle" },
    });
  });

  it("installs the global lookup index idempotently for month ranges and latest selection", () => {
    const { library } = setup();
    library.db.init();
    expect(library.db.get("SELECT sql FROM sqlite_master WHERE name = 'idx_vocabulary_lookup'")).toEqual({
      sql: "CREATE INDEX idx_vocabulary_lookup ON vocabulary(looked_up_at DESC, id)",
    });
    const plans = [
      library.db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM vocabulary WHERE looked_up_at >= ?", month_start),
      library.db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT * FROM vocabulary ORDER BY looked_up_at DESC, id LIMIT 1"),
    ];
    for (const plan of plans) {
      expect(plan.some(row => row.detail.includes("idx_vocabulary_lookup"))).toBe(true);
      expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
    }
  });
});
