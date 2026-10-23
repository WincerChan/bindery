import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { convertEpub } from "../src/client/boko/conversion";
import { writeArchive } from "../src/core/archive";
import { decodeKindlePosition, parseReaderDataStore, ReaderDataStoreError, type ReaderStoreValue } from "../src/client/kindle/reading-store";
import { KfxPositionsError, kindlePosition, readKfxPositions } from "../src/client/kindle/kfx-positions";

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
  it("rejects a malformed or non-boko KFX with a typed error", async () => {
    await expect(readKfxPositions(new Blob([new Uint8Array(64)]))).rejects.toBeInstanceOf(KfxPositionsError);
    await expect(readKfxPositions(new Blob([encoder.encode("CONT")]))).rejects.toBeInstanceOf(KfxPositionsError);
  });
});
