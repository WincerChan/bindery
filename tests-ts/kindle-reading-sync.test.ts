import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readArchive } from "../src/core/archive";
import { epubPath } from "../src/server/storage";
import { readBookArchive } from "../src/server/reader/service";
import { mapKindlePosition } from "../src/server/reading/kindle";
import { kindleReadingInput, syncKindleReading } from "../src/server/reading/sync";
import { latestProgress } from "../src/server/reading/progress";
import { createBook } from "./fixtures/library/support";
import { readerFixture } from "./fixtures/reader/support";

let fixtures: ReturnType<typeof readerFixture>[] = [];
const fixture = () => { const value = readerFixture(); fixtures.push(value); return value; };
afterEach(() => { fixtures.forEach(value => value.cleanup()); fixtures = []; });
const device = { id: "ko3-1", kind: "kindle" as const, name: "Oasis 3" };
const kindleEntry = (book_id: string, patch: Partial<ReturnType<typeof baseEntry>> = {}) => ({ ...baseEntry(book_id), ...patch });
const baseEntry = (book_id: string) => ({
  book_id, location: "AXEDAAAAAAAA:3", chapter: null as number | null, chapter_count: 3, chapter_fraction: null as number | null,
  percent: 0, last_read_at: "2026-10-22T13:11:20Z",
});
const syncInput = (books: ReturnType<typeof kindleEntry>[]) => ({ device, books });
const sectionsOf = (library: ReturnType<typeof readerFixture>["library"], id: string) => readBookArchive(id, library).metadata().sections;
const fallback = (library: ReturnType<typeof readerFixture>["library"], id: string, percent: number) => {
  const sections = sectionsOf(library, id);
  const sizes = new Map(readArchive(readFileSync(epubPath(library.base, id))).map(entry => [entry.name, entry.data.length]));
  const weights = sections.map(section => sizes.get(section.item_path)!), total = weights.reduce((sum, size) => sum + size, 0), target = percent / 100 * total;
  let start = 0, index = 0;
  while (index < weights.length - 1 && target >= start + weights[index]) start += weights[index++];
  return { section: index, section_fraction: (target - start) / weights[index] };
};

describe("Kindle reading position mapping", () => {
  it("uses the exact reader section and fraction when the chapter count matches", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id);
    expect(mapKindlePosition(library, id, kindleEntry(id, { chapter: 1, chapter_count: sections.length, chapter_fraction: 0.615, percent: 39 }))).toEqual({ section: 1, section_fraction: 0.615, percent: 39 });
    expect(mapKindlePosition(library, id, kindleEntry(id, { chapter: 2, chapter_count: sections.length, chapter_fraction: -0.5, percent: 39 }))).toMatchObject({ section: 2, section_fraction: 0 });
    expect(mapKindlePosition(library, id, kindleEntry(id, { chapter: 2, chapter_count: sections.length, chapter_fraction: 1.5, percent: 39 }))).toMatchObject({ section: 2, section_fraction: 1 });
  });
  it("falls back to a byte-weighted whole-book percent when the chapter count differs", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id), expected = fallback(library, id, 60);
    const mapped = mapKindlePosition(library, id, kindleEntry(id, { chapter: 1, chapter_count: sections.length + 1, chapter_fraction: 0.9, percent: 60 }));
    expect(mapped.section).toBe(expected.section);
    expect(mapped.section_fraction).toBeCloseTo(expected.section_fraction, 10);
    expect(mapped.percent).toBe(60);
    expect(mapKindlePosition(library, id, kindleEntry(id, { chapter: null, chapter_count: sections.length, percent: 39 }))).toMatchObject({ section: fallback(library, id, 39).section, percent: 39 });
  });
});

describe("Kindle sync validation and storage", () => {
  const valid = () => ({ device, books: [kindleEntry("a".repeat(32))] });
  it("accepts the documented input shape", () => {
    expect(kindleReadingInput(valid())).toEqual(valid());
    expect(kindleReadingInput({ ...valid(), books: [] })).toEqual({ device, books: [] });
  });
  it.each([
    ["too many entries", { ...valid(), books: Array.from({ length: 5001 }, () => kindleEntry("a".repeat(32))) }],
    ["a malformed book id", { ...valid(), books: [kindleEntry("A".repeat(32))] }],
    ["a missing location", { ...valid(), books: [kindleEntry("a".repeat(32), { location: undefined as unknown as string })] }],
    ["a non-finite percent", { ...valid(), books: [kindleEntry("a".repeat(32), { percent: Infinity })] }],
    ["a non-finite chapter fraction", { ...valid(), books: [kindleEntry("a".repeat(32), { chapter_fraction: NaN })] }],
    ["a fractional chapter", { ...valid(), books: [kindleEntry("a".repeat(32), { chapter: 0.5 })] }],
    ["a chapter outside its count", { ...valid(), books: [kindleEntry("a".repeat(32), { chapter: 3, chapter_count: 3 })] }],
    ["a fractional chapter count", { ...valid(), books: [kindleEntry("a".repeat(32), { chapter_count: 3.5 })] }],
    ["a missing read time", { ...valid(), books: [kindleEntry("a".repeat(32), { last_read_at: null as unknown as string })] }],
    ["a non-ISO read time", { ...valid(), books: [kindleEntry("a".repeat(32), { last_read_at: "2026-10-22 13:11:20" })] }],
    ["an invalid read time", { ...valid(), books: [kindleEntry("a".repeat(32), { last_read_at: "yesterday" })] }],
    ["a non-Kindle device", { ...valid(), device: { id: "x", kind: "kobo", name: "Libra" } }],
    ["a missing device name", { ...valid(), device: { id: "x", kind: "kindle", name: "" } }],
    ["a non-array books field", { ...valid(), books: null }],
  ])("rejects %s", (_name, input) => {
    expect(() => kindleReadingInput(input as never)).toThrow("同步数据无效");
    expect(() => syncKindleReading(fixture().library, input as never)).toThrow("同步数据无效");
  });
  it("skips unknown and archived books and reports identical re-syncs as unchanged", () => {
    const { library, id } = fixture(), archivedId = "c".repeat(32);
    createBook(library, archivedId, { archived: true });
    const entry = kindleEntry(id, { chapter: 1, chapter_count: sectionsOf(library, id).length, percent: 10 }), unknown = kindleEntry("b".repeat(32));
    expect(syncKindleReading(library, syncInput([entry, unknown, kindleEntry(archivedId)]))).toEqual({ synced: 1, skipped: 2, marked_read: 0, unchanged: 0, kept: 0 });
    expect(syncKindleReading(library, syncInput([entry, unknown, kindleEntry(archivedId)]))).toEqual({ synced: 0, skipped: 2, marked_read: 0, unchanged: 1, kept: 0 });
    expect(library.db.listDeviceReading(unknown.book_id)).toEqual([]);
    expect(library.db.listDeviceReading(archivedId)).toEqual([]);
  });
  it("stores a Kindle row with no reading time and never marks the book read", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id);
    expect(library.loadMetadata(id).read).toBe(false);
    expect(syncKindleReading(library, syncInput([kindleEntry(id, { chapter: sections.length - 1, chapter_count: sections.length, chapter_fraction: 1, percent: 100 })]))).toEqual({ synced: 1, skipped: 0, marked_read: 0, unchanged: 0, kept: 0 });
    expect(library.loadMetadata(id).read).toBe(false);
    expect(library.db.getWishByLibraryBookId(id)?.read_status).not.toBe("read");
    expect(library.db.listDeviceReading(id)[0]).toMatchObject({ device_kind: "kindle", read_status: "reading", time_spent_seconds: 0, rest_estimate_seconds: null, percent: 100, section: sections.length - 1, section_fraction: 1 });
  });
  it("keeps the stored Kindle position when the device reports an older read", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id), stored = () => library.db.listDeviceReading(id)[0];
    syncKindleReading(library, syncInput([kindleEntry(id, { chapter: 1, chapter_count: sections.length, chapter_fraction: 0.6, percent: 39 })]));
    expect(syncKindleReading(library, syncInput([kindleEntry(id, { chapter: 0, chapter_count: sections.length, percent: 1, last_read_at: "2026-10-22T09:00:00Z" })]))).toMatchObject({ synced: 0, kept: 1 });
    expect(stored()).toMatchObject({ section: 1, section_fraction: 0.6, percent: 39, last_read_at: "2026-10-22T13:11:20Z" });
    expect(syncKindleReading(library, syncInput([kindleEntry(id, { chapter: 0, chapter_count: sections.length, percent: 39 })]))).toMatchObject({ synced: 1, kept: 0 });
    expect(stored()).toMatchObject({ section: 0, section_fraction: 0 });
  });
});

describe("Kindle progress alongside web and Kobo rows", () => {
  it("lets the newest reading time win across all sources", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id);
    library.db.upsertReaderProgress(id, 1, 3, 11, "2026-10-22T13:00:00Z");
    library.db.upsertDeviceReading({
      book_id: id, device_id: "kobo-1", device_kind: "kobo", device_name: "Libra 2", section: 2, section_fraction: 0.5,
      percent: 70, location: null, read_status: "reading", last_read_at: "2026-10-22T13:11:20Z",
      time_spent_seconds: 132, rest_estimate_seconds: 8943, synced_at: "2026-10-22T13:12:00Z",
    });
    syncKindleReading(library, syncInput([kindleEntry(id, { chapter: 1, chapter_count: sections.length, chapter_fraction: 0.25, percent: 40, last_read_at: "2026-10-22T14:00:00Z" })]));
    expect(latestProgress(library, id)).toEqual({ source: { device_id: device.id, device_name: device.name, kind: "kindle" }, section: 1, section_fraction: 0.25, percent: 40, read_at: "2026-10-22T14:00:00Z" });
    library.db.upsertReaderProgress(id, 0, 2, 9, "2026-10-22T15:00:00Z");
    expect(latestProgress(library, id)).toMatchObject({ source: "web", read_at: "2026-10-22T15:00:00Z" });
    expect(library.db.listDeviceReading(id)).toHaveLength(2);
  });
  it("never creates or changes reader_progress during a Kindle sync", () => {
    const { library, id } = fixture(), sections = sectionsOf(library, id);
    library.db.upsertReaderProgress(id, 0, 2, 9, "2026-10-20T00:00:00Z");
    const before = library.db.all("SELECT * FROM reader_progress ORDER BY book_id");
    syncKindleReading(library, syncInput([kindleEntry(id, { chapter: sections.length - 1, chapter_count: sections.length, chapter_fraction: 0.9, percent: 88 })]));
    expect(library.db.all("SELECT * FROM reader_progress ORDER BY book_id")).toEqual(before);
  });
});
