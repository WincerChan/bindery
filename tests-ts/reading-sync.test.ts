import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { readArchive } from "../src/core/archive";
import { sanitizeEpubMemberPaths } from "../src/core/epub-safe-paths";
import { epubPath } from "../src/server/storage";
import { loadReader, readBookArchive } from "../src/server/reader/service";
import { mapKoboPosition, type KoboEntry } from "../src/server/reading/kobo";
import { koboReadingInput, syncKoboReading } from "../src/server/reading/sync";
import { latestProgress } from "../src/server/reading/progress";
import { loadBookPage } from "../src/server/books/service";
import { createBook } from "./fixtures/library/support";
import { obfuscatedEpub } from "./fixtures/reader/obfuscated";
import { readerFixture } from "./fixtures/reader/support";

let fixtures: ReturnType<typeof readerFixture>[] = [];
const fixture = () => { const value = readerFixture(); fixtures.push(value); return value; };
afterEach(() => { fixtures.forEach(value => value.cleanup()); fixtures = []; });
const device = { id: "libra-2", kind: "kobo" as const, name: "Libra 2" };
const koboEntry = (book_id: string, patch: Partial<KoboEntry> = {}): KoboEntry => ({
  book_id, location: null, chapter_fraction: null, percent: 0, read_status: 1,
  last_read_at: "2026-10-22T13:11:20Z", time_spent_seconds: 0, rest_estimate_seconds: null, ...patch,
});
const syncInput = (books: KoboEntry[]) => ({ device, books });
const sectionsOf = (library: ReturnType<typeof readerFixture>["library"], id: string) => readBookArchive(id, library).metadata().sections;

describe("Kobo reading position mapping", () => {
  it("maps an exact chapter path and clamps the fraction within the section", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id);
    const mapped = mapKoboPosition(library, id, koboEntry(id, { location: `${sections[1].item_path}#kobo.48.1`, chapter_fraction: 0.615, percent: 39 }));
    expect(mapped).toEqual({ section: 1, section_fraction: 0.615, percent: 39 });
    expect(mapKoboPosition(library, id, koboEntry(id, { location: sections[2].item_path, chapter_fraction: -0.5, percent: 39 }))).toMatchObject({ section: 2, section_fraction: 0 });
    expect(mapKoboPosition(library, id, koboEntry(id, { location: sections[2].item_path, chapter_fraction: 1.5, percent: 39 }))).toMatchObject({ section: 2, section_fraction: 1 });
  });
  it("treats kepubify's inserted title page as the start of section zero", () => {
    const { library, id } = fixture();
    expect(mapKoboPosition(library, id, koboEntry(id, { location: "OEBPS/kepubify-titlepage-dummy.xhtml#kobo.1.1", chapter_fraction: 0.9, percent: 3 }))).toEqual({ section: 0, section_fraction: 0, percent: 3 });
  });
  it("maps a path sanitized by the KEPUB pipeline back to the library member", () => {
    const { library, id } = fixture(), original = obfuscatedEpub(3);
    writeFileSync(epubPath(library.base, id), original.data);
    const sanitized = sanitizeEpubMemberPaths(original.data);
    expect(sanitized.changed).toBe(true);
    const originalNames = original.entries.map(entry => entry.name), sanitizedNames = readArchive(sanitized.data).map(entry => entry.name);
    const source = original.paths[1], koboPath = sanitizedNames[originalNames.indexOf(source)];
    expect(koboPath).not.toBe(source);
    expect(sectionsOf(library, id)[1].item_path).toBe(source);
    expect(mapKoboPosition(library, id, koboEntry(id, { location: `${koboPath}#kobo.48.1`, chapter_fraction: 0.25, percent: 12 }))).toEqual({ section: 1, section_fraction: 0.25, percent: 12 });
  });
  it("falls back to a byte-weighted whole-book percent", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id);
    const sizes = new Map(readArchive(readFileSync(epubPath(library.base, id))).map(entry => [entry.name, entry.data.length]));
    const weights = sections.map(section => sizes.get(section.item_path)!), total = weights.reduce((sum, size) => sum + size, 0), percent = 60;
    const target = percent / 100 * total;
    let start = 0, index = 0;
    while (index < weights.length - 1 && target >= start + weights[index]) start += weights[index++];
    const mapped = mapKoboPosition(library, id, koboEntry(id, { location: "OEBPS/unknown.xhtml#kobo.9.1", chapter_fraction: 0.8, percent }));
    expect(mapped.section).toBe(index);
    expect(mapped.section_fraction).toBeCloseTo((target - start) / weights[index], 10);
    expect(mapped.percent).toBe(percent);
  });
  it("returns a null position for a book Kobo has never opened", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id);
    expect(mapKoboPosition(library, id, koboEntry(id, { location: sections[1].item_path, chapter_fraction: 0.5, percent: 0, last_read_at: null }))).toEqual({ section: null, section_fraction: null, percent: 0 });
  });
});

describe("Kobo sync validation and storage", () => {
  const valid = () => ({ device, books: [koboEntry("a".repeat(32))] });
  it("accepts the documented input shape", () => {
    expect(koboReadingInput(valid())).toEqual(valid());
    expect(koboReadingInput({ ...valid(), books: [] })).toEqual({ device, books: [] });
  });
  it.each([
    ["too many entries", { ...valid(), books: Array.from({ length: 5001 }, () => koboEntry("a".repeat(32))) }],
    ["a malformed book id", { ...valid(), books: [koboEntry("A".repeat(32))] }],
    ["a non-finite percent", { ...valid(), books: [koboEntry("a".repeat(32), { percent: Infinity })] }],
    ["a non-finite chapter fraction", { ...valid(), books: [koboEntry("a".repeat(32), { chapter_fraction: NaN })] }],
    ["an unknown read status", { ...valid(), books: [koboEntry("a".repeat(32), { read_status: 3 as unknown as 0 })] }],
    ["an invalid last read time", { ...valid(), books: [koboEntry("a".repeat(32), { last_read_at: "yesterday" })] }],
    ["negative time spent", { ...valid(), books: [koboEntry("a".repeat(32), { time_spent_seconds: -1 })] }],
    ["a non-Kobo device", { ...valid(), device: { id: "x", kind: "kindle", name: "Paperwhite" } }],
    ["a missing device name", { ...valid(), device: { id: "x", kind: "kobo", name: "" } }],
    ["a non-array books field", { ...valid(), books: null }],
  ])("rejects %s", (_name, input) => {
    expect(() => koboReadingInput(input)).toThrow("同步数据无效");
    expect(() => syncKoboReading(fixture().library, input)).toThrow("同步数据无效");
  });
  it("upserts one row per device and lists newest first", () => {
    const { library, id } = fixture(), base = {
      book_id: id, device_id: device.id, device_kind: device.kind, device_name: device.name, section: 1, section_fraction: 0.2,
      percent: 20, location: null, read_status: "reading", last_read_at: "2026-10-22T13:11:20Z",
      time_spent_seconds: 10, rest_estimate_seconds: 100, synced_at: "2026-10-22T13:12:00Z",
    };
    library.db.upsertDeviceReading(base);
    const updated = { ...base, section_fraction: 0.7, percent: 70 };
    library.db.upsertDeviceReading(updated);
    library.db.upsertDeviceReading({ ...base, device_id: "older", device_name: "Older", last_read_at: "2026-10-21T13:11:20Z" });
    expect(library.db.listDeviceReading(id).map(row => [row.device_id, row.section_fraction])).toEqual([[device.id, 0.7], ["older", 0.2]]);
  });
  it("skips unknown and archived books, and reports identical re-syncs as unchanged", () => {
    const { library, id } = fixture(), archivedId = "c".repeat(32);
    createBook(library, archivedId, { archived: true });
    const entry = koboEntry(id, { location: sectionsOf(library, id)[0].item_path, chapter_fraction: 0.4, percent: 10 }), unknown = koboEntry("b".repeat(32));
    expect(syncKoboReading(library, syncInput([entry, unknown, koboEntry(archivedId)]))).toEqual({ synced: 1, skipped: 2, marked_read: 0, unchanged: 0, kept: 0 });
    expect(syncKoboReading(library, syncInput([entry, unknown, koboEntry(archivedId)]))).toEqual({ synced: 0, skipped: 2, marked_read: 0, unchanged: 1, kept: 0 });
    expect(library.db.listDeviceReading(unknown.book_id)).toEqual([]);
    expect(library.db.listDeviceReading(archivedId)).toEqual([]);
  });
});

describe("device positions that went backwards", () => {
  it("keeps the stored position when the device reports a reset or an older read, and accepts equal or newer ones", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id), stored = () => library.db.listDeviceReading(id)[0];
    syncKoboReading(library, syncInput([koboEntry(id, { location: sections[1].item_path, chapter_fraction: 0.6, percent: 39 })]));
    // A re-transferred book the Kobo now treats as never opened.
    expect(syncKoboReading(library, syncInput([koboEntry(id, { last_read_at: null, percent: 0, read_status: 0 })]))).toMatchObject({ synced: 0, kept: 1 });
    expect(stored()).toMatchObject({ section: 1, section_fraction: 0.6, percent: 39, last_read_at: "2026-10-22T13:11:20Z" });
    expect(syncKoboReading(library, syncInput([koboEntry(id, { location: sections[0].item_path, last_read_at: "2026-10-22T09:00:00Z" })]))).toMatchObject({ kept: 1 });
    expect(stored().section).toBe(1);
    // Same read time, different position (e.g. the library EPUB changed): the device still wins.
    expect(syncKoboReading(library, syncInput([koboEntry(id, { location: sections[0].item_path, chapter_fraction: 0.2, percent: 39 })]))).toMatchObject({ synced: 1, kept: 0 });
    expect(stored()).toMatchObject({ section: 0, section_fraction: 0.2 });
  });
});

describe("authoritative progress", () => {
  it("marks a finished Kobo book read and never marks it unread again", () => {
    const { library, id } = fixture(), location = sectionsOf(library, id)[1].item_path;
    expect(library.loadMetadata(id).read).toBe(false);
    const first = syncKoboReading(library, syncInput([koboEntry(id, { location, chapter_fraction: 0.615, percent: 39, read_status: 2, time_spent_seconds: 132, rest_estimate_seconds: 8943 })]));
    expect(first).toEqual({ synced: 1, skipped: 0, marked_read: 1, unchanged: 0, kept: 0 });
    expect(library.loadMetadata(id).read).toBe(true);
    expect(library.db.getWishByLibraryBookId(id)?.read_status).toBe("read");
    expect(library.db.listDeviceReading(id)[0]).toMatchObject({ read_status: "finished", section: 1, section_fraction: 0.615, percent: 39, time_spent_seconds: 132, rest_estimate_seconds: 8943 });
    const second = syncKoboReading(library, syncInput([koboEntry(id, { location, chapter_fraction: 0.1, percent: 10, read_status: 0, last_read_at: "2026-10-22T14:00:00Z" })]));
    expect(second).toMatchObject({ synced: 1, marked_read: 0, unchanged: 0, kept: 0 });
    expect(library.loadMetadata(id).read).toBe(true);
    expect(library.db.getWishByLibraryBookId(id)?.read_status).toBe("read");
    expect(library.db.listDeviceReading(id)[0].read_status).toBe("unread");
  });
  it("chooses the newest web or device row and converts web pages to a section fraction", () => {
    const { library, id } = fixture();
    library.db.upsertReaderProgress(id, 1, 3, 11, "2026-10-22T13:00:00Z");
    library.db.upsertDeviceReading({
      book_id: id, device_id: "kobo-1", device_kind: "kobo", device_name: "Libra 2", section: 2, section_fraction: 0.5,
      percent: 70, location: null, read_status: "reading", last_read_at: "2026-10-22T13:11:20Z",
      time_spent_seconds: 132, rest_estimate_seconds: 8943, synced_at: "2026-10-22T13:12:00Z",
    });
    expect(latestProgress(library, id)).toEqual({ source: { device_id: "kobo-1", device_name: "Libra 2", kind: "kobo" }, section: 2, section_fraction: 0.5, percent: 70, read_at: "2026-10-22T13:11:20Z" });
    expect(loadReader(id, "0", "/", library).latest_progress).toEqual(latestProgress(library, id));
    library.db.upsertReaderProgress(id, 0, 3, 11, "2026-10-22T14:00:00Z");
    expect(latestProgress(library, id)).toEqual({ source: "web", section: 0, section_fraction: 0.2, page: 3, page_count: 11, read_at: "2026-10-22T14:00:00Z" });
    expect(latestProgress(library, "f".repeat(32))).toBeNull();
  });
  it("lists every source for book detail with titles, percent estimates and the newest marker", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id);
    library.db.upsertReaderProgress(id, 1, 3, 11, "2026-10-22T13:00:00Z");
    library.db.upsertDeviceReading({
      book_id: id, device_id: "kobo-1", device_kind: "kobo", device_name: "Libra 2", section: 2, section_fraction: 0.5,
      percent: 70, location: null, read_status: "reading", last_read_at: "2026-10-22T13:11:20Z",
      time_spent_seconds: 132, rest_estimate_seconds: 8943, synced_at: "2026-10-22T13:12:00Z",
    });
    expect(loadBookPage(id, "/", library).reading_progress).toEqual([
      expect.objectContaining({ source_label: "Libra 2", section: 2, section_title: sections[2].title, percent: 70, time_spent_seconds: 132, rest_estimate_seconds: 8943, latest: true }),
      expect.objectContaining({ source: "web", source_label: "网页阅读器", section: 1, section_title: sections[1].title, percent: 40, time_spent_seconds: null, rest_estimate_seconds: null, latest: false }),
    ]);
  });
  it("never creates or changes reader_progress during a device sync", () => {
    const { library, id } = fixture();
    library.db.upsertReaderProgress(id, 0, 2, 9, "2026-10-20T00:00:00Z");
    const before = library.db.all("SELECT * FROM reader_progress ORDER BY book_id");
    syncKoboReading(library, syncInput([koboEntry(id, { location: sectionsOf(library, id)[2].item_path, chapter_fraction: 0.9, percent: 88, read_status: 2 })]));
    expect(library.db.all("SELECT * FROM reader_progress ORDER BY book_id")).toEqual(before);
  });
});
