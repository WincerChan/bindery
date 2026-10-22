import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { convertToKepub } from "../src/core/kepub";
import { inventory } from "../src/client/devices/inventory";
import { detectDevice, pairDetectedDevice } from "../src/client/devices/identity";
import { deleteBook } from "../src/client/devices/operations";
import { validateDevicePath } from "../src/client/devices/transaction";
import { KoboTransferService } from "../src/client/devices/kobo/transfer";
import { koboReadingEntries, parseKoboContent, readKoboReading } from "../src/client/devices/kobo/reading";
import { parseKoboManifest } from "../src/client/devices/kobo/manifest";
import { koboReadingSummary } from "../src/features/devices/kobo-sync";
import { fakeKobo } from "./support/fake-fs";

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "bindery-kobo-reading-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
interface FixtureRow { content_id: string; read_status?: number; percent?: number; location?: string | null; fraction?: number | null; date?: string | null; time?: number; estimate?: number | null }
function database(rows: FixtureRow[]) {
  const path = join(temp(), "KoboReader.sqlite"), db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE content (ContentID TEXT, ContentType INTEGER, ReadStatus INTEGER, ___PercentRead INTEGER, ChapterIDBookmarked TEXT, CurrentChapterProgress REAL, DateLastRead TEXT, TimeSpentReading INTEGER, RestOfBookEstimate INTEGER)`);
    const insert = db.prepare("INSERT INTO content VALUES (?, 6, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) insert.run(row.content_id, row.read_status ?? 1, row.percent ?? 0, row.location ?? null, row.fraction ?? null, row.date ?? null, row.time ?? 0, row.estimate ?? null);
  } finally { db.close(); }
  return new Uint8Array(readFileSync(path));
}
const bookId = (value: number) => String(value).repeat(32).slice(0, 32);

describe("Kobo reading database", () => {
  it("parses Bindery content rows and ignores everything else", async () => {
    const rows = await parseKoboContent(database([
      { content_id: "file:///mnt/onboard/Bindery/Holes.kepub.epub", read_status: 1, percent: 39, location: "OEBPS/Sach_c22_r1.htm#kobo.48.1", fraction: 0.615, date: "2026-10-22T13:11:20Z", time: 132, estimate: 8943 },
      { content_id: "file:///mnt/onboard/Bindery/未读.kepub.epub", read_status: 0, percent: 0 },
      { content_id: "file:///mnt/onboard/Other/ignored.kepub.epub", read_status: 2, percent: 100 },
    ]));
    expect(rows).toEqual([
      { filename: "Bindery/Holes.kepub.epub", location: "OEBPS/Sach_c22_r1.htm#kobo.48.1", chapter_fraction: 0.615, percent: 39, read_status: 1, last_read_at: "2026-10-22T13:11:20Z", time_spent_seconds: 132, rest_estimate_seconds: 8943 },
      { filename: "Bindery/未读.kepub.epub", location: null, chapter_fraction: null, percent: 0, read_status: 0, last_read_at: null, time_spent_seconds: 0, rest_estimate_seconds: null },
    ]);
  });
  it("maps manifest records first and falls back to a unique library filename", async () => {
    const manifest = parseKoboManifest({ version: 1, books: [{ book_id: bookId(1), filename: "Bindery/甲.kepub.epub", transferred_at: "2026-10-22T13:12:00Z" }] });
    const rows = await parseKoboContent(database([
      { content_id: "file:///mnt/onboard/Bindery/甲.kepub.epub", percent: 10 },
      { content_id: "file:///mnt/onboard/Bindery/乙.kepub.epub", percent: 20 },
      { content_id: "file:///mnt/onboard/Bindery/丙.kepub.epub", percent: 30 },
    ]));
    const mapped = koboReadingEntries(rows, manifest, [{ book_id: bookId(2), title: "乙" }, { book_id: bookId(3), title: "丙" }, { book_id: bookId(4), title: "丙" }]);
    expect(mapped.entries.map(entry => [entry.book_id, entry.percent])).toEqual([[bookId(1), 10], [bookId(2), 20]]);
    expect(mapped.unmatched).toBe(1);
    expect([...mapped.bookIds.keys()]).toEqual(["bindery/甲.kepub.epub", "bindery/乙.kepub.epub"]);
  });
  it("reads the main database through the device handle without writing and reports a non-empty WAL", async () => {
    const fs = await fakeKobo();
    await fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: [{ book_id: bookId(1), filename: "Bindery/甲.kepub.epub", transferred_at: "2026-10-22T13:12:00Z" }] }));
    await fs.write(".kobo/KoboReader.sqlite", database([{ content_id: "file:///mnt/onboard/Bindery/甲.kepub.epub", percent: 39, read_status: 1 }]));
    await fs.write(".kobo/KoboReader.sqlite-wal", "pending");
    fs.operations = [];
    const reading = await readKoboReading(fs.root);
    expect(reading.entries).toEqual([expect.objectContaining({ book_id: bookId(1), percent: 39 })]); expect(reading.wal).toBe(true);
    expect(fs.operations.filter(operation => /createWritable|write|close|remove|get:directory:create|get:file:create/.test(operation.operation))).toEqual([]);
    await fs.write(".kobo/KoboReader.sqlite-wal", "");
    expect((await readKoboReading(fs.root)).wal).toBe(false);
  });
});

describe("Kobo manifest transfer and deletion", () => {
  it("writes the record with the book and removes it with the book", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    const fixture = new Uint8Array(readFileSync(new URL("./fixtures/parity/kepub/input-mixed.epub", import.meta.url)));
    const service = new KoboTransferService({ fetch: async () => new Response(fixture), converter: { convert: async data => { const result = convertToKepub(data); return { data: result.data, stats: result.stats }; } } });
    const record = await service.transferBook(device, bookId(1));
    const manifest = JSON.parse(await fs.text(".bindery/manifest.json"));
    expect(manifest).toEqual({ version: 1, books: [{ book_id: bookId(1), filename: `Bindery/${record.filename}`, transferred_at: expect.any(String) }] });
    await service.transferBook(device, bookId(1));
    expect(JSON.parse(await fs.text(".bindery/manifest.json")).books).toHaveLength(1);
    await deleteBook(device, `Bindery/${record.filename}`);
    expect(JSON.parse(await fs.text(".bindery/manifest.json")).books).toEqual([]);
    expect(() => validateDevicePath([".bindery", "manifest.json"], "kobo")).not.toThrow();
  });
});

describe("Kobo inventory progress", () => {
  it("fills manifest and fallback book IDs plus last-read progress", async () => {
    const fs = await fakeKobo();
    await fs.write("Bindery/甲.kepub.epub", "A"); await fs.write("Bindery/乙.kepub.epub", "B");
    const books = [{ book_id: bookId(1), title: "甲" }, { book_id: bookId(2), title: "乙" }];
    await fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: [{ book_id: books[0].book_id, filename: "Bindery/甲.kepub.epub", transferred_at: "2026-10-22T13:12:00Z" }] }));
    await fs.write(".kobo/KoboReader.sqlite", database([
      { content_id: "file:///mnt/onboard/Bindery/甲.kepub.epub", read_status: 1, percent: 39, date: "2026-10-22T13:11:20Z" },
      { content_id: "file:///mnt/onboard/Bindery/乙.kepub.epub", read_status: 2, percent: 100, date: "2026-10-22T14:11:20Z" },
    ]));
    const result = await inventory(fs.root, "kobo", [], { koboBooks: books });
    expect(result.books.find(book => book.filename === "Bindery/甲.kepub.epub")).toEqual(expect.objectContaining({ book_id: bookId(1), record: expect.objectContaining({ book_id: bookId(1) }), progress: { read_status: 1, percent: 39, last_read_at: "2026-10-22T13:11:20Z" } }));
    expect(result.books.find(book => book.filename === "Bindery/乙.kepub.epub")).toEqual(expect.objectContaining({ book_id: bookId(2), record: expect.objectContaining({ book_id: bookId(2) }), progress: { read_status: 2, percent: 100, last_read_at: "2026-10-22T14:11:20Z" } }));
  });
  it("formats the auto-sync summary from the server result", () => {
    expect(koboReadingSummary({ synced: 5, skipped: 0, marked_read: 1, unchanged: 0, lagged: false, unmatched: 0 })).toBe("已同步 5 本书的阅读进度 · 1 本标为已读");
    expect(koboReadingSummary({ synced: 0, skipped: 1, marked_read: 0, unchanged: 2, lagged: true, unmatched: 3 })).toBe("已同步 2 本书的阅读进度 · 3 本未匹配到书库 · Kobo 阅读数据可能滞后");
  });
});
