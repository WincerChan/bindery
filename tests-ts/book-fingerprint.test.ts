import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { convertEpub } from "../src/client/boko/conversion";
import { convertToKepub } from "../src/core/kepub";
import { buildEpub } from "../src/core/epub";
import { metadataFromDict } from "../src/core/models";
import { parseBook } from "../src/core/parsing";
import { bookFingerprint, createLibraryMatcher } from "../src/core/fingerprint";
import { normalizeIdentity } from "../src/core/identity";
import { parseManifest, readManifest, type ManifestBook } from "../src/client/kindle/manifest";
import { EMPTY_SETTINGS } from "../src/client/devices/profiles";
import { parseKoboManifest } from "../src/client/devices/kobo/manifest";
import { inventory } from "../src/client/devices/inventory";
import { readKfxBookMetadata } from "../src/client/kindle/kfx-metadata";
import { readKfxPositions } from "../src/client/kindle/kfx-positions";
import { readKindleReading } from "../src/client/kindle/reading";
import { koboReadingEntries, type KoboContentRow } from "../src/client/devices/kobo/reading";
import { KindleTransferService } from "../src/client/kindle/transfer";
import { KoboTransferService } from "../src/client/devices/kobo/transfer";
import { defaultProfile } from "../src/client/devices/profiles";
import { pairDevice } from "../src/client/kindle/identity";
import { detectDevice, pairDetectedDevice } from "../src/client/devices/identity";
import { createDeviceLibraryResolver, type DeviceLibraryBook } from "../src/features/devices/library";
import { fakeKindle, fakeKobo } from "./support/fake-fs";
import { lprStore, positionString } from "./support/kindle-reading";

const id = (value: string) => value.repeat(32).slice(0, 32), wasm = readFileSync(new URL("../vendor/boko/boko_bg.wasm", import.meta.url));
const title = "规训与惩罚", author = "米歇尔·福柯";
const epub = new Uint8Array(buildEpub(parseBook("书名：规训与惩罚\n作者：米歇尔·福柯\n第一章 酷刑\n正文段落", "source"), metadataFromDict({ book_id: id("a"), title, author, identifier: "urn:uuid:book-fingerprint-tests" })));
let converted: Awaited<ReturnType<typeof convertEpub>>;
beforeAll(async () => { converted = await convertEpub(epub, wasm); });
const libraryBook = (book_id: string, bookTitle = title, bookAuthor: string | null = author): DeviceLibraryBook => ({ book_id, title: bookTitle, author: bookAuthor, cover_url: null, read: false });
const kindleRecord = (book_id: string, filename: string, extra: Partial<ManifestBook> = {}): ManifestBook => ({
  book_id, filename, content_id: "content_old", cde_content_type: "EBOK", profile_id: "default", profile_name: "默认",
  transferred_at: "2026-10-22T13:12:00Z", size: converted.data.length, thumbnail: null, ...extra,
});
const kindleService = () => new KindleTransferService({
  converter: { async convert() { return converted; } },
  fetch: async () => new Response(epub),
  profile: async () => defaultProfile(),
  thumbnail: async () => new Uint8Array([255, 216, 255, 217]),
});
const koboService = () => new KoboTransferService({
  fetch: async () => new Response(epub),
  converter: { convert: async data => { const result = convertToKepub(data); return { data: result.data, stats: result.stats }; } },
});
class RecordingBlob extends Blob {
  readonly ranges: Array<[number, number]> = [];
  slice(start = 0, end = this.size, contentType?: string): Blob {
    this.ranges.push([start, end]); return super.slice(start, end, contentType);
  }
}

describe("book fingerprint", () => {
  it("uses the upload duplicate rule for punctuation, case and spacing, and skips empty titles", async () => {
    expect(normalizeIdentity("  The Book!! ")).toBe("thebook");
    expect(await bookFingerprint("The Book!", "A. Author")).toBe(await bookFingerprint("  the   book ", "a author"));
    expect(await bookFingerprint(title, author)).toBe(await bookFingerprint(`《${title}》`, author.replace("·", " ")));
    expect(await bookFingerprint("《》", author)).toBeNull();
    expect(await bookFingerprint("  ", null)).toBeNull();
    expect(await bookFingerprint(title, author)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("matches by book id first, then fingerprint, and never guesses an ambiguous fingerprint", async () => {
    const books = [libraryBook(id("a")), libraryBook(id("b"), "另一本", "另一作者"), libraryBook(id("c"), "同名", "同作者"), libraryBook(id("d"), "同名", "同作者")];
    const matcher = await createLibraryMatcher(books);
    expect(await createLibraryMatcher(books)).toBe(matcher);
    expect(matcher.match({ book_id: id("a"), fingerprint: await bookFingerprint("无关", null) })).toBe(id("a"));
    expect(matcher.match({ book_id: id("e"), fingerprint: await bookFingerprint(title, author) })).toBe(id("a"));
    expect(matcher.match({ fingerprint: await bookFingerprint("同名", "同作者") })).toBeNull();
    expect(matcher.match({ fingerprint: "not-a-fingerprint" })).toBeNull();
  });
  it("reads title and author from a converted KFX with bounded ranged reads", async () => {
    const file = new RecordingBlob([converted.data, new Uint8Array(6 * 1024 * 1024)]);
    const metadata = await readKfxBookMetadata(file);
    expect(metadata).toEqual({ title, author });
    expect(await bookFingerprint(metadata.title, metadata.author)).toBe(await bookFingerprint(title, author));
    const totalRead = file.ranges.reduce((sum, [start, end]) => sum + end - start, 0);
    expect(totalRead).toBeLessThan(256 * 1024);
    expect(totalRead).toBeLessThan(file.size / 10);
  });
  it("writes the fingerprint on Kindle and Kobo transfers and still parses old manifests", async () => {
    const expected = await bookFingerprint(title, author), fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    const kindle = await kindleService().transferBook(device, id("a"));
    expect(kindle.fingerprint).toBe(expected);
    expect((await readManifest(fs.root)).books[0]).toEqual(kindle);
    const oldKindle = { ...kindleRecord(id("b"), "old.kfx") };
    expect(parseManifest({ version: 1, books: [oldKindle] }).books[0]!.fingerprint).toBeUndefined();
    expect(() => parseManifest({ version: 1, books: [{ ...oldKindle, fingerprint: "A".repeat(64) }] })).toThrow();

    const kobo = await fakeKobo(), koboDevice = await pairDetectedDevice(kobo.root, await detectDevice(kobo.root), "libra2", "Libra");
    const transferred = await koboService().transferBook(koboDevice, id("a"));
    const koboManifest = parseKoboManifest(JSON.parse(await kobo.text(".bindery/manifest.json")));
    expect(koboManifest.books[0]).toEqual({ book_id: id("a"), filename: `Bindery/${transferred.filename}`, transferred_at: expect.any(String), fingerprint: expected, settings: EMPTY_SETTINGS });
    const oldKobo = { book_id: id("b"), filename: "Bindery/Old.kepub.epub", transferred_at: "2026-10-22T13:12:00Z" };
    expect(parseKoboManifest({ version: 1, books: [oldKobo] }).books[0]!.fingerprint).toBeUndefined();
    expect(() => parseKoboManifest({ version: 1, books: [{ ...oldKobo, fingerprint: "abc" }] })).toThrow();
  });
  it("exposes a KFX-derived fingerprint on old Kindle inventory records", async () => {
    const fs = await fakeKindle(), old = kindleRecord(id("b"), `${title}.kfx`);
    await fs.write(`documents/${old.filename}`, converted.data);
    await fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: [old] }));
    expect((await inventory(fs.root)).books[0]!.fingerprint).toBe(await bookFingerprint(title, author));
  });
  it("overwrites an old Kobo record by fingerprint at its existing filename", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    const fingerprint = await bookFingerprint(title, author), old = { book_id: id("b"), filename: "Bindery/旧名.kepub.epub", transferred_at: "2026-10-22T13:12:00Z", fingerprint };
    await fs.write(old.filename, "old"); await fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: [old] }));
    const result = await koboService().transferBook(device, id("a"), "default", { overwrite: true });
    expect(result.filename).toBe("旧名.kepub.epub");
    expect(parseKoboManifest(JSON.parse(await fs.text(".bindery/manifest.json"))).books).toEqual([{ book_id: id("a"), filename: old.filename, transferred_at: expect.any(String), fingerprint, settings: EMPTY_SETTINGS }]);
    await expect(fs.bytes(`Bindery/${title}.kepub.epub`)).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("overwrites an old Kindle record by its KFX fingerprint, keeping the file and .sdr and rewriting id + fingerprint", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), old = kindleRecord(id("b"), `${title}.kfx`);
    await fs.write(`documents/${old.filename}`, converted.data); await fs.write(`documents/${title}.sdr/position.yjf`, "reading");
    await fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: [old] }));
    const record = await kindleService().transferBook(device, id("a"), "default", { overwrite: true });
    expect(record.filename).toBe(old.filename);
    expect(record.book_id).toBe(id("a"));
    expect(record.fingerprint).toBe(await bookFingerprint(title, author));
    expect((await readManifest(fs.root)).books).toEqual([record]);
    expect(await fs.text(`documents/${title}.sdr/position.yjf`)).toBe("reading");
    await expect(fs.bytes(`documents/${title} (2).kfx`)).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("resolves foreign-id device records by fingerprint for Kindle and Kobo reading sync", async () => {
    const books = [libraryBook(id("a"))], resolver = await createDeviceLibraryResolver(books, "kindle");
    const fs = await fakeKindle(), old = kindleRecord(id("b"), `${title}.kfx`);
    await fs.write(`documents/${old.filename}`, converted.data);
    const positions = await readKfxPositions(new Blob([converted.data])), chapter = positions.chapters.find(item => !item.cover)!;
    const eid = [...chapter.eids][0]!;
    await fs.write(`documents/${title}.sdr/position.yjf`, lprStore(positionString(eid, 0, chapter.startPid), 1_792_748_847_039n));
    const reading = await readKindleReading(fs.root, { version: 1, books: [old] }, resolver.match);
    expect(reading.entries.map(entry => entry.book_id)).toEqual([id("a")]);

    const fingerprint = await bookFingerprint(title, author), row: KoboContentRow = {
      filename: "Bindery/规训与惩罚.kepub.epub", location: null, chapter_fraction: null, percent: 12, read_status: 1,
      last_read_at: "2026-10-22T13:11:20Z", time_spent_seconds: 0, rest_estimate_seconds: null,
    };
    const koboManifest = parseKoboManifest({ version: 1, books: [{ book_id: id("b"), filename: row.filename, transferred_at: "2026-10-22T13:12:00Z", fingerprint }] });
    const koboResolver = await createDeviceLibraryResolver(books, "kobo");
    expect(koboReadingEntries([row], koboManifest, books, koboResolver.match).entries.map(entry => entry.book_id)).toEqual([id("a")]);

    const ambiguous = [libraryBook(id("c"), title, author), libraryBook(id("d"), title, author)], ambiguousResolver = await createDeviceLibraryResolver(ambiguous, "kobo");
    const unmatched = koboReadingEntries([row], koboManifest, ambiguous, ambiguousResolver.match);
    expect(unmatched.entries).toEqual([]); expect(unmatched.unmatched).toBe(1);
  });
});
