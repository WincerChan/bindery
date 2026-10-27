import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countDocumentWords } from "../src/core/text";
import { decodeHtmlDocument } from "../src/core/html-encoding";
import * as counting from "../src/server/books/word-count-estimate";
import { writeArchive } from "../src/core/archive";
import { bookFromDict, metadataFromDict, metadataToDict } from "../src/core/models";
import { BinderyDatabase } from "../src/server/db";
import { TABLES } from "../src/server/db/schema";
import { initSchema } from "../src/server/db/init";
import { LibraryStorage, bookDir, epubPath, saveBook } from "../src/server/storage";
import { fetchBookMetadata, loadBookPage, saveBookEdit, setReadStatus } from "../src/server/books/service";
import { bookFileStats, cachedBookFileStats } from "../src/server/books/word-count";
import { bookView } from "../src/server/book-view";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), openSync: vi.fn(fs.openSync) };
});

const roots: string[] = [], id = "a".repeat(32), encode = (text: string) => new TextEncoder().encode(text);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), "bindery-word-count-")); roots.push(path); return path; }
function payload(first: string | Uint8Array = "中文 don't stop", second: string | Uint8Array = "かな 한글") {
  return writeArchive([
    { name: "mimetype", data: encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encode('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>') },
    { name: "book.opf", data: encode('<package><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="unused" href="unused.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>') },
    { name: "a.xhtml", data: typeof first === "string" ? encode(`<html><head><title>Not counted</title></head><body><p>${first}</p></body></html>`) : first },
    { name: "b.xhtml", data: typeof second === "string" ? encode(`<html><body><p>${second}</p></body></html>`) : second },
    { name: "unused.xhtml", data: encode("<p>Not in the spine 不计入</p>") },
  ]);
}
function fixture() {
  const base = root(), library = new LibraryStorage(join(base, "library"), new BinderyDatabase(join(base, "bindery.db")));
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(base, "templates"));
  const meta = metadataFromDict({ book_id: id, title: "Example", source_type: "epub", custom_css: "p { color: red }", created_at: "old", updated_at: "old", epub_updated_at: "old" });
  library.saveMetadata(meta);
  saveBook(bookFromDict({ title: meta.title }), library.base, id);
  const path = epubPath(library.base, id);
  writeFileSync(path, payload());
  return { library, path, meta };
}

describe("pure document word counting", () => {
  it.each([
    ["中文かなカナ한글", 8],
    ["𠀀𰀀﨑〇 ｶﾅ カー", 8],
    ["hello world abc123 2026", 4],
    ["don't l’esprit mother-in-law 'quoted' -edge- a--b", 7],
    ["café cafe\u0301 naïve Æsir ＡＢＣ１２３", 5],
    ["，。！？ … — + © ™ 😀 \n\t", 0],
    ["αβγ русский 한", 0],
    ["<p>中English文123</p>", 4],
    ['<HEAD><title>Ignore 中文</title><style>body {font: foo}</style></HEAD><p data-note="> ignored words">hello</p><script>if (a < b) { text = "words 中文" }</script><STYLE>ignored 中文</STYLE>', 1],
    ["<p>hel<em>lo</em><!-- hidden 中文 -->world</p><p>next<br/>line</p>", 3],
    ["<p>one&nbsp;two &amp; three &lt; &gt; &quot; &copy; &#x4E2D;&#25991; don&apos;t</p>", 6],
    ["<p>caf&eacute; &#x20000; &#x1f600; &NotEqualTilde; &#x110000; &#0;</p>", 2],
    ["<!DOCTYPE html><?xml-stylesheet hidden words?><p><![CDATA[中文 hello &amp;]]></p>", 4],
    ["<p>visible</p><script>unclosed hidden 中文", 1],
    ["<p>visible</p><!-- unclosed hidden 中文", 1],
    ["", 0],
  ])("counts %j as %i", (html, expected) => expect(countDocumentWords(html)).toBe(expected));
});

describe("chapter encodings", () => {
  it.each(["GB18030", "GBK", "GB2312"].flatMap(encoding => [
    `<?xml version="1.0" encoding="${encoding}"?><html><body>`,
    `<html><head><meta charset='${encoding}'></head><body>`,
    `<html><head><META content="text/html; charset=${encoding}" HTTP-EQUIV="Content-Type"></head><body>`,
  ]))("counts declared Chinese text: %s", declaration => {
    const { library, path } = fixture();
    const chapter = Buffer.concat([Buffer.from(declaration), Buffer.from("d6d0cec4", "hex"), Buffer.from(" hello</body></html>")]);
    expect(decodeHtmlDocument(chapter)).toContain("中文 hello");
    writeFileSync(path, payload(chapter));
    expect(bookFileStats(id, library).word_count).toBe(7); // Three units plus four in the other chapter.
  });
  it("decodes four-byte GB18030 supplementary ideographs", () => {
    const { library, path } = fixture();
    const chapter = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="GB18030"?><p>'), Buffer.from("d6d0cec495328236", "hex"), Buffer.from("</p>")]);
    expect(decodeHtmlDocument(chapter)).toContain("中文𠀀");
    writeFileSync(path, payload(chapter));
    expect(bookFileStats(id, library).word_count).toBe(7);
  });
  it.each(["le", "be"])("counts UTF-16%s with BOM, overriding a conflicting declaration", endian => {
    const { library, path } = fixture(), text = '<?xml version="1.0" encoding="UTF-8"?><html><body>中文 hello</body></html>';
    const chapter = Buffer.from(`\uFEFF${text}`, "utf16le");
    if (endian === "be") chapter.swap16();
    expect(decodeHtmlDocument(chapter)).toBe(text);
    writeFileSync(path, payload(chapter));
    expect(bookFileStats(id, library).word_count).toBe(7);
  });
  it("uses XML before meta and UTF-8 BOM before either declaration", () => {
    const text = '<?xml version="1.0" encoding="UTF-8"?><html><head><meta charset="GBK"></head><body>中文</body></html>';
    expect(decodeHtmlDocument(encode(text))).toBe(text);
    const conflicting = text.replace('encoding="UTF-8"', 'encoding="GBK"');
    expect(decodeHtmlDocument(encode(`\uFEFF${conflicting}`))).toBe(conflicting);
  });
  it("ignores fake declarations in comments, scripts and quoted attributes", () => {
    const text = `<html><head><!-- <meta charset="GBK"> --><script>const meta = '<meta charset="GBK">'</script><link title='<meta charset="GBK">'></head><body>中文</body></html>`;
    expect(decodeHtmlDocument(encode(text))).toBe(text);
  });
  it.each(["", '<?xml version="1.0" encoding="unknown-charset"?>', '<meta charset="GB18030">'])("salvages an undecodable chapter without nulling the book: %s", declaration => {
    const { library, path } = fixture();
    const chapter = Buffer.concat([Buffer.from(`${declaration}<p>valid `), Buffer.from([0xff]), Buffer.from(" words</p>")]);
    expect(decodeHtmlDocument(chapter)).toContain("valid \uFFFD words");
    writeFileSync(path, payload(chapter));
    expect(bookFileStats(id, library).word_count).toBe(6);
    const iterator = vi.spyOn(counting, "countEpubWords");
    expect(bookFileStats(id, library).word_count).toBe(6);
    expect(iterator).not.toHaveBeenCalled();
  });
});

describe("EPUB file-identity cache", () => {
  it("loads every spine document and exposes counts only on the detail view", () => {
    const { library, path, meta } = fixture(), iterator = vi.spyOn(counting, "countEpubWords");
    expect(bookView(meta, library)).not.toHaveProperty("word_count");
    expect(bookView(meta, library)).not.toHaveProperty("file_size");
    expect(iterator).not.toHaveBeenCalled();
    const page = loadBookPage(id, "/", library), stat = statSync(path);
    expect(page.book).toMatchObject({ word_count: 8, file_size: stat.size });
    expect(page.book).not.toHaveProperty("word_count_key");
    expect(library.db.get("SELECT word_count, word_count_key FROM books WHERE book_id = ?", id)).toEqual({ word_count: 8, word_count_key: `v2:${stat.size}:${stat.mtimeMs}` });
    expect(iterator).toHaveBeenCalledTimes(1);
  });
  it("uses a persisted cache hit without extraction or persistence, even in a fresh storage instance", () => {
    const { library, path } = fixture();
    const first = loadBookPage(id, "/", library).book;
    const iterator = vi.spyOn(counting, "countEpubWords").mockImplementation(() => { throw new Error("must not extract"); });
    const fresh = new LibraryStorage(library.base, new BinderyDatabase(library.db.path)), writes = vi.spyOn(fresh.db, "run");
    vi.mocked(readFileSync).mockClear(); vi.mocked(openSync).mockClear();
    expect(loadBookPage(id, "/", fresh).book).toMatchObject({ word_count: first.word_count, file_size: statSync(path).size });
    expect(iterator).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(vi.mocked(readFileSync).mock.calls.filter(([filename]) => filename === path)).toEqual([]);
    expect(vi.mocked(openSync).mock.calls.filter(([filename]) => filename === path)).toEqual([]);
  });
  it("invalidates legacy algorithm keys while keeping mutation replies cache-only", () => {
    const { library, path } = fixture(), stat = statSync(path);
    library.db.run("UPDATE books SET word_count = ?, word_count_key = ? WHERE book_id = ?", 123, `${stat.size}:${stat.mtimeMs}`, id);
    expect(cachedBookFileStats(id, library)).toEqual({ word_count: 123, file_size: stat.size });
    const count = vi.spyOn(counting, "countEpubWords");
    expect(bookFileStats(id, library).word_count).toBe(8);
    expect(count).toHaveBeenCalledTimes(1);
    expect(library.db.get("SELECT word_count_key FROM books WHERE book_id = ?", id)).toEqual({ word_count_key: `v2:${stat.size}:${stat.mtimeMs}` });
    expect(cachedBookFileStats(id, library)).toEqual({ word_count: 8, file_size: stat.size });
  });
  it("invalidates on mtime alone and size alone", () => {
    const { library, path } = fixture();
    expect(bookFileStats(id, library).word_count).toBe(8);
    const iterator = vi.spyOn(counting, "countEpubWords"), stat = statSync(path);
    utimesSync(path, stat.atime, new Date(stat.mtimeMs + 2000));
    expect(bookFileStats(id, library).word_count).toBe(8);
    expect(iterator).toHaveBeenCalledTimes(1);
    const changed = statSync(path);
    writeFileSync(path, payload("中文新增 don't stop"));
    utimesSync(path, changed.atime, changed.mtime);
    expect(statSync(path).size).not.toBe(changed.size);
    expect(statSync(path).mtimeMs).toBe(changed.mtimeMs);
    expect(bookFileStats(id, library).word_count).toBe(10);
    expect(iterator).toHaveBeenCalledTimes(2);
  });
  it("returns nulls for missing EPUBs instead of stale cached data, then counts a restored file", () => {
    const { library, path } = fixture();
    loadBookPage(id, "/", library);
    rmSync(path);
    expect(loadBookPage(id, "/", library).book).toMatchObject({ word_count: null, file_size: null });
    writeFileSync(path, payload("new content"));
    expect(loadBookPage(id, "/", library).book.word_count).toBe(6);
  });
  it("caches corrupt EPUB failures with size fallback and retries after replacement", () => {
    const { library, path } = fixture();
    writeFileSync(path, "not an EPUB");
    const opens = vi.mocked(openSync); opens.mockClear();
    expect(loadBookPage(id, "/", library).book).toMatchObject({ word_count: null, file_size: 11 });
    expect(loadBookPage(id, "/", library).book).toMatchObject({ word_count: null, file_size: 11 });
    expect(opens.mock.calls.filter(([filename]) => filename === path)).toHaveLength(1);
    writeFileSync(path, payload());
    expect(loadBookPage(id, "/", library).book.word_count).toBe(8);
  });
  it("returns null for an unreadable package document rather than a partial count", () => {
    const { library, path } = fixture();
    writeFileSync(path, writeArchive([{ name: "chapter.xhtml", data: encode("<p>orphan content</p>") }]));
    expect(bookFileStats(id, library)).toEqual({ word_count: null, file_size: statSync(path).size });
  });
  it("returns the stat size when the EPUB cannot be read", () => {
    const { library, path } = fixture();
    vi.mocked(openSync).mockImplementationOnce(() => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); });
    expect(bookFileStats(id, library)).toEqual({ word_count: null, file_size: statSync(path).size });
  });
  it("does not persist a count when the EPUB changes during extraction", () => {
    const { library, path } = fixture(), original = counting.countEpubWords;
    vi.spyOn(counting, "countEpubWords").mockImplementationOnce(archive => {
      const result = original(archive);
      writeFileSync(path, payload("replacement with different content"));
      return result;
    });
    expect(bookFileStats(id, library).word_count).toBeNull();
    expect(library.db.get("SELECT word_count, word_count_key FROM books WHERE book_id = ?", id)).toEqual({ word_count: null, word_count_key: null });
    expect(bookFileStats(id, library).word_count).toBe(8);
  });
  it("keeps zero distinct from a failed count", () => {
    const { library, path } = fixture();
    writeFileSync(path, payload("", ""));
    expect(loadBookPage(id, "/", library).book.word_count).toBe(0);
    const iterator = vi.spyOn(counting, "countEpubWords");
    expect(loadBookPage(id, "/", library).book.word_count).toBe(0);
    expect(iterator).not.toHaveBeenCalled();
  });
  it("only updates cache columns, leaves files/metadata/tracker untouched, and preserves the cache on upsert", () => {
    const { library, path, meta } = fixture(), beforeRow = library.db.get("SELECT * FROM books WHERE book_id = ?", id), files = readdirSync(bookDir(library.base, id)), beforeFiles = files.map(name => readFileSync(join(bookDir(library.base, id), name))), beforeStat = statSync(path);
    const save = vi.spyOn(library, "saveMetadata");
    bookFileStats(id, library);
    const { word_count, word_count_key, ...afterRow } = library.db.get("SELECT * FROM books WHERE book_id = ?", id)!;
    expect({ ...afterRow, word_count: null, word_count_key: null }).toEqual(beforeRow);
    expect(save).not.toHaveBeenCalled();
    expect(library.db.listWishes()).toEqual([]);
    expect(readdirSync(bookDir(library.base, id))).toEqual(files);
    expect(files.map(name => readFileSync(join(bookDir(library.base, id), name)))).toEqual(beforeFiles);
    expect(statSync(path).mtimeMs).toBe(beforeStat.mtimeMs);
    for (const value of [library.loadMetadata(id), ...library.listBooks(), ...library.listBooksPage()[0]]) {
      expect(metadataToDict(value)).not.toHaveProperty("word_count");
      expect(metadataToDict(value)).not.toHaveProperty("word_count_key");
    }
    library.saveMetadata({ ...meta, title: "Edited" });
    expect(library.db.get("SELECT word_count, word_count_key FROM books WHERE book_id = ?", id)).toEqual({ word_count, word_count_key });
  });
});

describe("mutation statistics are cache-only", () => {
  it.each([false, true])("does not extract on any edit/lookup/read response (cached: %s)", async warm => {
    const { library, path } = fixture();
    const stats = warm ? bookFileStats(id, library) : { word_count: null, file_size: null };
    const before = library.db.get("SELECT word_count, word_count_key FROM books WHERE book_id = ?", id);
    writeFileSync(path, payload("different content after regeneration"));
    const iterator = vi.spyOn(counting, "countEpubWords"), reads = vi.mocked(readFileSync);
    reads.mockClear(); vi.mocked(openSync).mockClear();
    expect(cachedBookFileStats(id, library)).toEqual(stats);
    const read = setReadStatus(id, "1", library);
    expect(read.read).toBe(true);
    expect(read).not.toHaveProperty("word_count");
    expect(read).not.toHaveProperty("file_size");
    for (const queued of [true, false]) {
      const form = new FormData(); form.set("title", "Edited");
      const result = await saveBookEdit(id, form, library, () => ({ queued }));
      expect(result.queued).toBe(queued);
      expect(result.page.book).toMatchObject(stats);
    }
    const css = new FormData(); css.set("custom_css", "a{");
    const invalidCss = await saveBookEdit(id, css, library);
    expect(invalidCss.page.error).toContain("CSS");
    expect(invalidCss.page.book).toMatchObject(stats);
    const cover = new FormData(); cover.set("cover_file", new File([], "empty.png"));
    const emptyCover = await saveBookEdit(id, cover, library);
    expect(emptyCover.page.error).toBe("封面文件为空");
    expect(emptyCover.page.book).toMatchObject(stats);
    const lookup = await fetchBookMetadata(id, new FormData(), library, async () => { throw new Error("offline"); });
    expect(lookup.error).toBeTruthy();
    expect(lookup.book).toMatchObject(stats);
    expect(iterator).not.toHaveBeenCalled();
    expect(reads.mock.calls.filter(([filename]) => filename === path)).toEqual([]);
    expect(vi.mocked(openSync).mock.calls.filter(([filename]) => filename === path)).toEqual([]);
    expect(library.db.get("SELECT word_count, word_count_key FROM books WHERE book_id = ?", id)).toEqual(before);
    // Only the next loader validates the new identity and replaces last-known statistics.
    expect(loadBookPage(id, "/", library).book.word_count).toBe(8);
    expect(iterator).toHaveBeenCalledTimes(1);
  });
});

it("migrates an existing books table without cache columns, preserving rows and remaining idempotent", () => {
  const db = new DatabaseSync(join(root(), "old.db"));
  try {
    db.exec(TABLES.find(sql => sql.includes("CREATE TABLE IF NOT EXISTS books ("))!);
    db.exec("INSERT INTO books(book_id, title, updated_at, epub_updated_at) VALUES ('old', 'Existing', 'then', 'then')");
    expect(db.prepare("PRAGMA table_info(books)").all().map(row => row.name)).not.toContain("word_count");
    initSchema(db); initSchema(db);
    expect(db.prepare("SELECT title, updated_at, epub_updated_at, word_count, word_count_key FROM books WHERE book_id = 'old'").get()).toEqual({ title: "Existing", updated_at: "then", epub_updated_at: "then", word_count: null, word_count_key: null });
    expect(db.prepare("PRAGMA table_info(books)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "word_count", type: "INTEGER" }), expect.objectContaining({ name: "word_count_key", type: "TEXT" })]));
  } finally { db.close(); }
});
