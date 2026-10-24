import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLibraryMatcher } from "../src/core/fingerprint";
import { createDeviceLibraryResolver } from "../src/features/devices/library";
import { cleanVocabularyWord } from "../src/core/vocabulary";
import { buildEpub } from "../src/core/epub";
import { parseBook } from "../src/core/parsing";
import { parseKoboVocabulary, koboVocabularyWords, readKoboVocabulary } from "../src/client/devices/kobo/vocabulary";
import { parseKindleVocabulary, readKindleVocabulary } from "../src/client/kindle/vocabulary";
import { parseKoboManifest } from "../src/client/devices/kobo/manifest";
import type { DeviceManifest } from "../src/client/kindle/manifest";
import { syncVocabulary } from "../src/server/vocabulary/sync";
import { vocabularyId } from "../src/server/vocabulary/id";
import { bookHtmlText, contextAt, readBookText, sentenceSpans, wordOffsets } from "../src/server/vocabulary/context";
import { epubPath } from "../src/server/storage";
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


describe("vocabulary context", () => {
  const device = { id: "libra-2", kind: "kobo" as const, name: "Libra 2" };
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 23, 16, minute)).toISOString();
  const word = (raw: string, minute: number, book_id: string | null, patch: Record<string, unknown> = {}) => ({
    lookup_id: null, raw_word: raw, word: cleanVocabularyWord(raw), lang: "-en-zh-CN", book_id, source_title: "Context Book", looked_up_at: at(minute), context: null, ...patch,
  });
  function withBook(library: ReturnType<typeof temporaryLibrary>["library"], id: string, body: string, title = "Context Book") {
    const meta = createBook(library, id, { title, author: "作者" });
    const book = parseBook(`书名：${title}\n作者：作者\n第一章 开篇\n${body}`, id);
    writeFileSync(epubPath(library.base, id), buildEpub(book, meta));
    return meta;
  }
  const context = (library: ReturnType<typeof temporaryLibrary>["library"], id: string) => JSON.parse(library.db.getVocabulary(id)!.context_json!) as { sentence: string; previous: string[]; following: string[]; offset: number };
  const reading = (library: ReturnType<typeof temporaryLibrary>["library"], book_id: string, fraction: number) => library.db.upsertDeviceReading({
    book_id, device_id: device.id, device_kind: device.kind, device_name: device.name, section: 0, section_fraction: fraction,
    percent: fraction * 100, location: null, read_status: "reading", last_read_at: "2026-10-23T16:00:00Z",
    time_spent_seconds: 0, rest_estimate_seconds: null, synced_at: "2026-10-23T16:00:00Z",
  });

  it("finds a single occurrence, keeps the sentence and its neighbours, and splits block/punctuation boundaries", () => {
    const { library } = temporaryLibrary(), id = bookId("d");
    withBook(library, id, "He likes to brag. Then he left.\n\nAnother paragraph! Did it work? Yes…");
    syncVocabulary(library, { device, words: [word("brag", 0, id)] });
    const row = library.db.listVocabulary()[0]!;
    expect(row).toMatchObject({ context_state: "found" });
    expect(context(library, row.id)).toMatchObject({ sentence: "He likes to brag.", following: ["Then he left.", "Another paragraph!"] });
    expect(context(library, row.id).previous.length).toBeLessThanOrEqual(2);
    expect(sentenceSpans("A. B? C! D。 E？ F！ G… H\nI").map(span => span.text)).toEqual(["A.", "B?", "C!", "D。", "E？", "F！", "G…", "H", "I"]);
    expect(bookHtmlText(new TextEncoder().encode("<p>One</p><p>Two<br/>Three</p>"))).toBe("One\n\nTwo\nThree");
  });

  it("resolves several occurrences in lookup order, taking the first after the previous word", () => {
    const { library } = temporaryLibrary(), id = bookId("e");
    withBook(library, id, "First brag happened. Middle sentence. Second brag happened.");
    const first = word("brag", 1, id), second = word("brag", 2, id);
    syncVocabulary(library, { device, words: [first, second] });
    const rows = library.db.listVocabularyForBookDevice(id, device.id);
    expect(rows.map(row => context(library, row.id).sentence)).toEqual(["First brag happened.", "Second brag happened."]);
  });

  it("uses the earliest occurrence when the next one is beyond the stored reading position", () => {
    const { library } = temporaryLibrary(), id = bookId("f");
    withBook(library, id, "A brag early. Then other appears. Then brag late.");
    reading(library, id, 0.05);
    syncVocabulary(library, { device, words: [word("other", 1, id), word("brag", 2, id)] });
    const rows = library.db.listVocabularyForBookDevice(id, device.id), brag = rows.find(row => row.word === "brag")!;
    expect(context(library, brag.id).sentence).toBe("A brag early.");
  });

  it("marks a missing occurrence as not_found with an empty sentence and still stores the word", () => {
    const { library } = temporaryLibrary(), id = bookId("a");
    withBook(library, id, "Only ordinary words here.");
    syncVocabulary(library, { device, words: [word("missing", 0, id)] });
    const row = library.db.listVocabulary()[0]!;
    expect(row).toMatchObject({ word: "missing", context_state: "not_found" });
    expect(JSON.parse(row.context_json!)).toEqual({ sentence: "", previous: [], following: [] });
  });

  it("matches CJK as a plain substring and strips punctuation before searching", () => {
    const { library } = temporaryLibrary(), id = bookId("b");
    withBook(library, id, "他说：“生词很重要。” 然后继续。");
    syncVocabulary(library, { device, words: [word("（生词）。", 0, id)] });
    const row = library.db.listVocabulary()[0]!;
    expect(row.word).toBe("生词");
    expect(context(library, row.id)).toMatchObject({ sentence: "他说：“生词很重要。”", following: ["然后继续。"] });
    const book = readBookText(library, id);
    expect(wordOffsets(book, "生词")).toHaveLength(1);
    expect(contextAt(book, wordOffsets(book, "生词")[0]!).sentence).toBe("他说：“生词很重要。”");
  });

  it("leaves a word pending until the book exists, then computes context on the next sync", () => {
    const { library } = temporaryLibrary(), id = bookId("c");
    const item = word("later", 0, id);
    syncVocabulary(library, { device, words: [item] });
    const row = library.db.listVocabulary()[0]!;
    expect(row).toMatchObject({ context_state: "pending", context_json: null });
    withBook(library, id, "The later sentence arrived.");
    const result = syncVocabulary(library, { device, words: [item] });
    expect(result).toMatchObject({ unchanged: 1, context_found: 1 });
    expect(context(library, row.id).sentence).toBe("The later sentence arrived.");
  });

  it("freezes a computed context after a push even when the book changes", () => {
    const { library } = temporaryLibrary(), id = bookId("1");
    withBook(library, id, "Original context brag.");
    const item = word("brag", 0, id);
    syncVocabulary(library, { device, words: [item] });
    const row = library.db.listVocabulary()[0]!, frozen = row.context_json;
    library.db.updateVocabularyPush(row.id, "pushed", JSON.stringify({ status: "saved" }), "2026-10-23T17:00:00Z", "2026-10-23T17:00:00Z");
    withBook(library, id, "Replacement context brag.");
    syncVocabulary(library, { device, words: [item] });
    expect(library.db.getVocabulary(row.id)).toMatchObject({ context_json: frozen, context_state: "found", push_state: "pushed" });
  });
});
