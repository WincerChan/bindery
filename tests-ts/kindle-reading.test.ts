import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { convertEpub } from "../src/client/boko/conversion";
import { writeArchive } from "../src/core/archive";
import { decodeKindlePosition, parseReaderDataStore, ReaderDataStoreError, type ReaderStoreValue } from "../src/client/kindle/reading-store";
import { KfxPositionsError, kindlePosition, readKfxPositions } from "../src/client/kindle/kfx-positions";
import { assetCover } from "./support/kindle-assets";

const wasm = readFileSync(new URL("../vendor/boko/boko_bg.wasm", import.meta.url)), encoder = new TextEncoder();
const object = (name: string | null, values: ReaderStoreValue[]): ReaderStoreValue => ({ name, values });
const bytes = (...parts: number[]) => new Uint8Array(parts);
const text = (value: string, empty = false) => [...(empty ? [1] : [0, ...u16(value.length)]), ...encoder.encode(value)];
const u16 = (value: number) => [value >> 8 & 255, value & 255];
const i64 = (value: bigint) => { const out = new Uint8Array(8); new DataView(out.buffer).setBigInt64(0, value); return [...out]; };
const value = (input: ReaderStoreValue): number[] => {
  if (input === null) return [0x03, 1];
  if (typeof input === "boolean") return [0x00, input ? 1 : 0];
  if (typeof input === "number") {
    if (Number.isInteger(input) && input >= -2147483648 && input <= 2147483647) { const out = new Uint8Array(4); new DataView(out.buffer).setInt32(0, input); return [0x01, ...out]; }
    const out = new Uint8Array(8); new DataView(out.buffer).setFloat64(0, input); return [0x04, ...out];
  }
  if (typeof input === "bigint") return [0x02, ...i64(input)];
  if (typeof input === "string") return [0x03, ...text(input)];
  if (typeof input === "object" && "name" in input) return [0xfe, ...(input.name === null ? [1] : [0, ...u16(input.name.length), ...encoder.encode(input.name)]), ...input.values.flatMap(value), 0xff];
  return [0x07, input];
};
function readerStore(values: ReaderStoreValue[]): Uint8Array {
  const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, values.length);
  const body = [0x02, ...i64(1n), 0x01, ...count, ...values.flatMap(value)];
  return new Uint8Array([0, 0, 0, 0, 0, 0x1a, 0xb1, 0x26, ...body]);
}
const positionBytes = (marker: number, eid: number, offset: number) => new Uint8Array([marker, eid & 255, eid >>> 8 & 255, eid >>> 16 & 255, eid >>> 24 & 255, offset & 255, offset >>> 8 & 255, offset >>> 16 & 255, offset >>> 24 & 255]);
const encodedPosition = (marker: number, eid: number, offset: number, pid: number) => `${btoa(String.fromCharCode(...positionBytes(marker, eid, offset)))}:${pid}`;
const position = (eid: number, offset: number, pid: number) => encodedPosition(1, eid, offset, pid);
const chapter = (number: number, body: string) => encoder.encode(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${number}章</title></head><body><h1>第${number}章</h1><p>${body}</p></body></html>`);
function miniEpub() {
  const titles = ["甲甲甲甲甲甲甲甲甲甲", "乙乙乙乙乙乙乙乙乙乙", "丙丙丙丙丙丙丙丙丙丙"];
  const manifest = titles.map((_, index) => `<item id="c${index}" href="Text/c${index}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = titles.map((_, index) => `<itemref idref="c${index}"/>`).join("");
  const opf = `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:kindle-reading-test</dc:identifier><dc:title>三章书</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine>${spine}</spine></package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${titles.map((_, index) => `<li><a href="Text/c${index}.xhtml">第${index + 1}章</a></li>`).join("")}</ol></nav></body></html>`;
  return writeArchive([
    { name: "mimetype", data: encoder.encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encoder.encode(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
    { name: "OEBPS/content.opf", data: encoder.encode(opf) },
    { name: "OEBPS/nav.xhtml", data: encoder.encode(nav) },
    ...titles.map((body, index) => ({ name: `OEBPS/Text/c${index}.xhtml`, data: chapter(index + 1, body) })),
  ]);
}
function coverCaseEpub(withCoverPage: boolean) {
  const cover = encoder.encode(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 292 425" preserveAspectRatio="none"><image width="292" height="425" xlink:href="../Images/cover.png"/></svg></div></body></html>`);
  const docs = [
    ...(withCoverPage ? [{ id: "titlepage", href: "Text/titlepage.xhtml", data: cover }] : []),
    ...[1, 2, 3].map(number => ({ id: `c${number}`, href: `Text/c${number}.xhtml`, data: chapter(number, "文".repeat(10)) })),
  ];
  const opf = `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:kindle-cover-case</dc:identifier><dc:title>封面测试</dc:title><dc:language>zh</dc:language><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="Images/cover.png" media-type="image/png" properties="cover-image"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${docs.map(doc => `<item id="${doc.id}" href="${doc.href}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${docs.map(doc => `<itemref idref="${doc.id}"/>`).join("")}</spine><guide><reference type="cover" href="Text/titlepage.xhtml"/></guide></package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${docs.map(doc => `<li><a href="${doc.href}">${doc.id}</a></li>`).join("")}</ol></nav></body></html>`;
  return writeArchive([
    { name: "mimetype", data: encoder.encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encoder.encode(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
    { name: "OEBPS/content.opf", data: encoder.encode(opf) },
    { name: "OEBPS/nav.xhtml", data: encoder.encode(nav) },
    { name: "OEBPS/Images/cover.png", data: assetCover },
    ...docs.map(doc => ({ name: `OEBPS/${doc.href}`, data: doc.data })),
  ]);
}
class RecordingBlob extends Blob {
  readonly ranges: Array<[number, number]> = [];
  constructor(parts: BlobPart[]) { super(parts); }
  slice(start = 0, end = this.size, contentType?: string): Blob {
    this.ranges.push([start, end]); return super.slice(start, end, contentType);
  }
}

describe("Kindle reader data store", () => {
  it("round-trips every KRDS value type and reads the 局外人 sample shape", () => {
    const store = parseReaderDataStore(readerStore([
      object("timer.model", [0n, 0n, 0n, 0, object("timer.average.calculator", [0, 0, 0, 0])]),
      object("fpr", [position(881, 0, 3), -1n, -1n, null, null]),
      object("book.info.store", [185n, 0.07340946166394781]),
      object("page.history.store", [0]),
      object("whisperstore.migration.status", [false, false]),
      object("lpr", [2, "AXEDAAAAAAAA:3", 1792748847039n]),
    ]));
    expect(store.version).toBe(1n);
    expect(store.values).toHaveLength(6);
    expect(store.fields.get("timer.model")).toEqual([0n, 0n, 0n, 0, object("timer.average.calculator", [0, 0, 0, 0])]);
    expect(store.fields.get("lpr")).toEqual([2, "AXEDAAAAAAAA:3", 1792748847039n]);
    expect(store.fields.get("fpr")?.[3]).toBeNull();
  });
  it("rejects a wrong magic, unknown types and truncated values", () => {
    const good = readerStore([object("lpr", [2, "AXEDAAAAAAAA:3", 1n])]);
    const wrongMagic = good.slice(); wrongMagic[7] = 0;
    expect(() => parseReaderDataStore(wrongMagic)).toThrow(ReaderDataStoreError);
    expect(() => parseReaderDataStore(new Uint8Array([...good, 0x05, 0]))).toThrow(ReaderDataStoreError);
    expect(() => parseReaderDataStore(good.subarray(0, good.length - 1))).toThrow(ReaderDataStoreError);
  });
  it("decodes a 12-character base64 position strictly", () => {
    expect(decodeKindlePosition(position(881, 0, 3))).toEqual({ eid: 881, offset: 0, pid: 3 });
    expect(decodeKindlePosition(position(0x12345678, 0x90abcdef, 12345))).toEqual({ eid: 0x12345678, offset: 0x90abcdef, pid: 12345 });
    const wrongMarker = encodedPosition(0, 881, 0, 3);
    for (const invalid of ["AXEDAAAAAAAA", "AXEDAAAAAAAA:3:4", "AXEDAAAAAAAA:-1", "AXEDAAAAAAAA:3x", "AXEDAAAAAAAA:", wrongMarker, `${"A".repeat(12)}:3`, "AXEDAAAAAAA:3"]) expect(() => decodeKindlePosition(invalid)).toThrow(ReaderDataStoreError);
  });
});

describe("KFX position maps", () => {
  it("reads chapters and maps positions with bounded ranged reads", async () => {
    const converted = await convertEpub(miniEpub(), wasm);
    const file = new RecordingBlob([converted.data, new Uint8Array(6 * 1024 * 1024)]);
    const positions = await readKfxPositions(file);
    expect(positions.chapters.map(chapter => chapter.index)).toEqual([0, 1, 2]);
    expect(positions.sectionCount).toBe(3);
    expect(positions.chapters.every(chapter => !chapter.cover)).toBe(true);
    expect(positions.totalPid).toBeGreaterThan(0);
    for (const chapter of positions.chapters) {
      expect(chapter.startPid).toBeLessThanOrEqual(chapter.endPid);
      expect(chapter.eids.size).toBeGreaterThan(0);
    }
    const totalRead = file.ranges.reduce((sum, [start, end]) => sum + end - start, 0);
    expect(totalRead).toBeLessThan(256 * 1024);
    expect(totalRead).toBeLessThan(file.size / 10);
    const target = positions.chapters[1]!, eid = [...target.eids][0]!;
    expect(kindlePosition(positions, { eid, pid: target.startPid })).toMatchObject({ chapter: 1, chapter_fraction: 0 });
    const middle = target.startPid + Math.floor((target.endPid - target.startPid) / 2);
    expect(kindlePosition(positions, { eid, pid: middle }).chapter_fraction).toBeCloseTo((middle - target.startPid) / (target.endPid - target.startPid), 10);
    expect(kindlePosition(positions, { eid: 0xffffffff, pid: middle })).toEqual({ chapter: null, chapter_fraction: null, percent: middle / positions.totalPid * 100 });
    expect(kindlePosition(positions, { eid, pid: positions.totalPid + 10 }).percent).toBe(100);
  });
  it("numbers sections including boko's cover for both spine layouts", async () => {
    for (const withCoverPage of [true, false]) {
      const converted = await convertEpub(coverCaseEpub(withCoverPage), wasm), positions = await readKfxPositions(new Blob([converted.data]));
      expect(positions.sectionCount).toBe(4);
      expect(positions.chapters.map(chapter => chapter.index)).toEqual([0, 1, 2, 3]);
      expect(positions.chapters[0]?.cover).toBe(true);
      expect(positions.chapters.filter(chapter => !chapter.cover)).toHaveLength(3);
    }
  });
  it("rejects a malformed or non-boko KFX with a typed error", async () => {
    await expect(readKfxPositions(new Blob([new Uint8Array(64)]))).rejects.toBeInstanceOf(KfxPositionsError);
    await expect(readKfxPositions(new Blob([encoder.encode("CONT")]))).rejects.toBeInstanceOf(KfxPositionsError);
  });
});

import { fakeKindle } from "./support/fake-fs";
import { lprStore, miniKfx, positionString } from "./support/kindle-reading";
import { readManifest, type DeviceManifest, type ManifestBook } from "../src/client/kindle/manifest";
import { readKindleReading } from "../src/client/kindle/reading";

const bookId = (value: string) => value.repeat(32).slice(0, 32);
const record = (book_id: string, filename: string, content_id: string, size = 0): ManifestBook => ({ book_id, filename, content_id, cde_content_type: "EBOK", profile_id: "default", profile_name: "默认", transferred_at: "2026-10-22T13:12:00Z", size, thumbnail: null });

describe("Kindle device reading pass", () => {
  it("reads the newest sidecar without writing, counts unreadable and unmatched books", async () => {
    const fs = await fakeKindle(), { data, positions } = await miniKfx();
    const first = positions.chapters[1]!, eid = [...first.eids][0]!, newer = positionString(eid, 0, first.startPid);
    const older = positionString([...positions.chapters[0]!.eids][0]!, 0, positions.chapters[0]!.startPid);
    const jia = record(bookId("1"), "甲.kfx", "content_jia", data.length), yi = record(bookId("2"), "乙.kfx", "content_yi", data.length);
    const bing = record(bookId("3"), "丙.kfx", "content_bing", data.length), ding = record(bookId("4"), "丁.kfx", "content_ding", data.length);
    const manifest: DeviceManifest = { version: 1, books: [jia, yi, bing, ding] };
    for (const book of manifest.books) await fs.write(`documents/${book.filename}`, book === ding ? "not a KFX" : data);
    await fs.write(`documents/甲.sdr/甲673205bd7b6c0394b1593a9fbced79ec.yjf`, lprStore(older, 1_792_748_800_000n));
    await fs.write(`documents/甲.sdr/甲673205bd7b6c0394b1593a9fbced79ec.yjf.bad_file`, "ignored");
    await fs.write(`documents/甲_content_jia.sdr/甲_content_jia673205bd7b6c0394b1593a9fbced79ec.yjf`, lprStore(newer, 1_792_748_847_039n));
    await fs.write(`documents/丙.sdr/丙673205bd7b6c0394b1593a9fbced79ec.yjf`, "broken");
    await fs.write(`documents/丁.sdr/丁673205bd7b6c0394b1593a9fbced79ec.yjf`, lprStore(newer, 1_792_748_847_039n));
    await fs.write(`documents/戊.sdr/戊673205bd7b6c0394b1593a9fbced79ec.yjf`, lprStore(newer, 1_792_748_847_039n));
    await fs.write(".bindery/manifest.json", JSON.stringify(manifest));
    fs.operations = [];
    const reading = await readKindleReading(fs.root, await readManifest(fs.root));
    const expected = { chapter: first.index, chapter_fraction: 0, percent: first.startPid / positions.totalPid * 100 };
    expect(reading).toEqual({
      entries: [{ book_id: jia.book_id, location: newer, kfx_section_count: positions.sectionCount, last_read_at: "2026-10-23T09:47:27.039Z", ...expected }],
      skipped: 3,
      unmatched: 1,
    });
    expect(fs.operations.filter(operation => /createWritable|write|close|remove|get:directory:create|get:file:create|abort/.test(operation.operation))).toEqual([]);
    expect((await readKindleReading(fs.root, manifest)).entries).toEqual(reading.entries);
  });
});

import { kindleReadingSummary } from "../src/features/devices/kindle-sync";
describe("Kindle reading summary", () => {
  it("reports synced, unreadable and older kept positions", () => {
    expect(kindleReadingSummary({ synced: 5, skipped: 0, marked_read: 0, unchanged: 0, kept: 0, unmatched: 0 })).toBe("已同步 5 本书的阅读进度");
    expect(kindleReadingSummary({ synced: 0, skipped: 2, marked_read: 0, unchanged: 3, kept: 1, unmatched: 4 })).toBe("已同步 3 本书的阅读进度 · 2 本无法读取 · 1 本设备进度较旧，已保留之前的记录");
  });
});
