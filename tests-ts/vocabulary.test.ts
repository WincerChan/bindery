import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLibraryMatcher } from "../src/core/fingerprint";
import { createDeviceLibraryResolver } from "../src/features/devices/library";
import { cleanVocabularyWord } from "../src/core/vocabulary";
import { parseKoboVocabulary, koboVocabularyWords, readKoboVocabulary } from "../src/client/devices/kobo/vocabulary";
import { parseKindleVocabulary, readKindleVocabulary } from "../src/client/kindle/vocabulary";
import { parseKoboManifest } from "../src/client/devices/kobo/manifest";
import type { DeviceManifest } from "../src/client/kindle/manifest";
import { syncVocabulary } from "../src/server/vocabulary/sync";
import { vocabularyId } from "../src/server/vocabulary/id";
import { createBook, temporaryLibrary } from "./fixtures/library/support";
import { fakeKindle, fakeKobo } from "./support/fake-fs";

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "bindery-vocabulary-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const bookId = (value: string) => value.repeat(32).slice(0, 32);
const words = (value: number) => String(value).padStart(4, "0").repeat(8).slice(0, 32);

function koboDatabase(rows: Array<{ text: string; volume: string; lang?: string | null; date?: string | null }>, table = true) {
  const path = join(temp(), "KoboReader.sqlite"), db = new DatabaseSync(path);
  try {
    if (table) {
      db.exec("CREATE TABLE WordList (Text TEXT, VolumeId TEXT, DictSuffix TEXT, DateCreated TEXT)");
      const insert = db.prepare("INSERT INTO WordList VALUES (?, ?, ?, ?)");
      for (const row of rows) insert.run(row.text, row.volume, row.lang ?? "-en-zh-CN", row.date ?? "2026-10-23T16:58:54Z");
    }
  } finally { db.close(); }
  return new Uint8Array(readFileSync(path));
}

function kindleDatabase(rows: Array<{ word: string; usage?: string | null; timestamp?: number | null; asin?: string | null; guid?: string | null; title?: string | null; authors?: string | null }>) {
  const path = join(temp(), "vocab.db"), db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE WORDS (id TEXT PRIMARY KEY, word TEXT, stem TEXT, lang TEXT, category TEXT, timestamp INTEGER, profileid TEXT);
      CREATE TABLE LOOKUPS (id TEXT PRIMARY KEY, word_key TEXT, book_key TEXT, dict_key TEXT, pos TEXT, usage TEXT, timestamp INTEGER);
      CREATE TABLE BOOK_INFO (id TEXT PRIMARY KEY, asin TEXT, guid TEXT, lang TEXT, title TEXT, authors TEXT)`);
    const word = db.prepare("INSERT INTO WORDS VALUES (?, ?, ?, 'en', 'ref', ?, 'p')");
    const lookup = db.prepare("INSERT INTO LOOKUPS VALUES (?, ?, ?, 'd', '0', ?, ?)");
    const book = db.prepare("INSERT INTO BOOK_INFO VALUES (?, ?, ?, 'en', ?, ?)");
    rows.forEach((row, index) => {
      const id = String(index + 1), bookKey = `b${index + 1}`, at = row.timestamp === null ? null : row.timestamp ?? 1792748400000 + index;
      word.run(id, row.word, row.word, at);
      lookup.run(`lookup-${id}`, id, bookKey, row.usage === undefined ? "A usage sentence." : row.usage, at);
      book.run(bookKey, row.asin ?? null, row.guid ?? null, row.title ?? null, row.authors ?? null);
    });
  } finally { db.close(); }
  return new Uint8Array(readFileSync(path));
}

describe("vocabulary words from device databases", () => {
  it("strips selection punctuation without touching internal apostrophes", () => {
    expect(cleanVocabularyWord("  “brag,”  ")).toBe("brag");
    expect(cleanVocabularyWord("don’t")).toBe("don’t");
    expect(cleanVocabularyWord("（生词）。")).toBe("生词");
  });

  it("reads Kobo WordList rows, skips malformed dates and tolerates a missing table", async () => {
    const parsed = await parseKoboVocabulary(koboDatabase([
      { text: "brag,", volume: "file:///mnt/onboard/Bindery/Holes.kepub.epub" },
      { text: "donkey", volume: "file:///mnt/onboard/Bindery/Holes.kepub.epub", date: "not a date" },
      { text: "  ", volume: "file:///mnt/onboard/Bindery/Holes.kepub.epub" },
    ]));
    expect(parsed.rows).toEqual([{ raw_word: "brag,", word: "brag", lang: "-en-zh-CN", filename: "Bindery/Holes.kepub.epub", looked_up_at: "2026-10-23T16:58:54.000Z" }]);
    expect(parsed.skipped).toBe(2);
    expect(await parseKoboVocabulary(koboDatabase([], false))).toEqual({ rows: [], skipped: 0 });
    const fs = await fakeKobo();
    expect(await readKoboVocabulary(fs.root)).toEqual({ words: [], skipped: 0 });
    expect(fs.operations.filter(operation => /createWritable|write|close|remove/.test(operation.operation))).toEqual([]);
  });

  it("maps Kobo VolumeId through the manifest, filename fallback and fingerprint resolver", async () => {
    const manifest = parseKoboManifest({ version: 1, books: [{ book_id: bookId("1"), filename: "Bindery/甲.kepub.epub", transferred_at: "2026-10-22T13:12:00Z" }] });
    const rows = (await parseKoboVocabulary(koboDatabase([
      { text: "甲", volume: "file:///mnt/onboard/Bindery/甲.kepub.epub" },
      { text: "乙", volume: "file:///mnt/onboard/Bindery/乙.kepub.epub" },
      { text: "丙", volume: "file:///mnt/onboard/Bindery/丙.kepub.epub" },
      { text: "丁", volume: "file:///mnt/onboard/Other/丁.kepub.epub" },
    ]))).rows;
    const books = [{ book_id: bookId("1"), title: "甲书", author: null, cover_url: null, read: false }, { book_id: bookId("2"), title: "乙", author: null, cover_url: null, read: false }, { book_id: bookId("3"), title: "丙", author: null, cover_url: null, read: false }, { book_id: bookId("4"), title: "丙", author: null, cover_url: null, read: false }];
    const resolver = await createDeviceLibraryResolver(books, "kobo");
    const mapped = koboVocabularyWords(rows, manifest, books, input => resolver.match(input));
    expect(mapped.map(word => [word.word, word.book_id, word.source_title])).toEqual([
      ["甲", bookId("1"), "甲书"],
      ["乙", bookId("2"), "乙"],
      ["丙", null, "丙"],
      ["丁", null, "丁"],
    ]);
  });

  it("reads Kindle LOOKUPS/WORDS/BOOK_INFO, maps ASIN/GUID and fingerprints, and keeps unmatched titles", async () => {
    const manifest: DeviceManifest = { version: 1, books: [{ book_id: bookId("a"), filename: "甲.kfx", content_id: "B0ASIN", cde_content_type: "EBOK", profile_id: "default", profile_name: "默认", transferred_at: "2026-10-22T13:12:00Z", size: 1, thumbnail: null }] };
    const resolver = await createLibraryMatcher([{ book_id: bookId("a"), title: "匹配书", author: "作者" }, { book_id: bookId("b"), title: "指纹书", author: "另作者" }]);
    const parsed = await parseKindleVocabulary(kindleDatabase([
      { word: "donkey", usage: "The donkey brayed.", asin: "B0ASIN", title: "Kindle 标题", authors: "某人" },
      { word: "brag,", usage: null, guid: "guid-2", title: "指纹书", authors: "另作者" },
      { word: "unknown", usage: "Unmatched.", title: "未匹配书名", authors: "无人" },
      { word: "broken", timestamp: null },
    ]), manifest, input => resolver.match(input));
    expect(parsed.words.map(word => [word.word, word.lookup_id, word.book_id, word.source_title, word.context?.sentence])).toEqual([
      ["donkey", "lookup-1", bookId("a"), "Kindle 标题", "The donkey brayed."],
      ["brag", "lookup-2", bookId("b"), "指纹书", ""],
      ["unknown", "lookup-3", null, "未匹配书名", "Unmatched."],
    ]);
    expect(parsed.skipped).toBe(1);
    expect((await parseKindleVocabulary(kindleDatabase([]), manifest)).words).toEqual([]);
    const fs = await fakeKindle();
    expect(await readKindleVocabulary(fs.root, manifest)).toEqual({ words: [], skipped: 0 });
  });

  it("reads a Kindle vocab.db through the device handle without writing", async () => {
    const fs = await fakeKindle(), data = kindleDatabase([{ word: "word", usage: "A word.", title: "书" }]);
    await fs.write("system/vocabulary/vocab.db", data);
    fs.operations = [];
    const parsed = await readKindleVocabulary(fs.root, { version: 1, books: [] });
    expect(parsed.words).toHaveLength(1); expect(parsed.words[0]).toMatchObject({ word: "word", source_title: "书" });
    expect(fs.operations.filter(operation => /createWritable|write|close|remove|get:directory:create|get:file:create/.test(operation.operation))).toEqual([]);
  });
});

describe("server vocabulary sync", () => {
  const device = { id: "libra-2", kind: "kobo" as const, name: "Libra 2" };
  const word = (patch: Record<string, unknown> = {}) => ({ lookup_id: null, raw_word: "brag,", word: "brag", lang: "-en-zh-CN", book_id: null, source_title: "Holes", looked_up_at: "2026-10-23T16:58:54Z", context: null, ...patch });

  it("derives a stable UUID and makes re-syncs idempotent without changing a frozen context", () => {
    const { library } = temporaryLibrary(), id = bookId("c");
    createBook(library, id, { title: "Holes", author: "Louis Sachar" });
    const first = syncVocabulary(library, { device, words: [word({ book_id: id, context: { sentence: "He would brag.", previous: [], following: [] } })] });
    expect(first).toMatchObject({ synced: 1, unchanged: 0, skipped: 0, context_found: 1 });
    const row = library.db.listVocabulary()[0]!;
    expect(row.id).toBe(vocabularyId(device.id, "brag,", "2026-10-23T16:58:54.000Z"));
    expect(row).toMatchObject({ word: "brag", raw_word: "brag,", book_id: id, push_state: "pending", context_state: "found" });
    const second = syncVocabulary(library, { device, words: [word({ book_id: id, context: { sentence: "Changed text.", previous: [], following: [] } })] });
    expect(second).toMatchObject({ synced: 0, unchanged: 1, skipped: 0 });
    expect(library.db.getVocabulary(row.id)).toMatchObject({ context_json: JSON.stringify({ sentence: "He would brag.", previous: [], following: [] }), context_state: "found" });
  });

  it("rejects malformed input and skips per-row identity problems", () => {
    const { library } = temporaryLibrary();
    expect(() => syncVocabulary(library, { device: { ...device, kind: "nope" }, words: [word()] })).toThrow("生词同步数据无效");
    expect(() => syncVocabulary(library, { device, words: [word({ looked_up_at: "yesterday" })] })).toThrow("生词同步数据无效");
    expect(() => syncVocabulary(library, { device, words: [word({ lookup_id: "x".repeat(200) })] })).toThrow("生词同步数据无效");
    expect(library.db.listVocabulary()).toEqual([]);
  });
});
