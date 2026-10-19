import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { unzipSync } from "fflate";
import { readArchive, writeArchive, writeArchiveToSink, type ArchiveMember } from "../src/core/archive";

const members: ArchiveMember[] = [
  { name: "mimetype", data: new TextEncoder().encode("application/epub+zip") },
  { name: "EPUB/text.xhtml", data: new TextEncoder().encode("<p>天下大势，分久必合</p>".repeat(200)) },
  { name: "EPUB/empty.css", data: new Uint8Array() },
];

function compressionMethods(zip: Uint8Array): Record<string, number> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength), methods: Record<string, number> = {};
  let end = zip.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  let offset = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const nameLength = view.getUint16(offset + 28, true);
    methods[new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength))] = view.getUint16(offset + 10, true);
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return methods;
}

describe("archive writer", () => {
  test("deflates members and keeps mimetype stored", () => {
    const zip = writeArchive(members);
    expect(compressionMethods(zip)).toEqual({ mimetype: 0, "EPUB/text.xhtml": 8, "EPUB/empty.css": 8 });
    expect(readArchive(zip)).toEqual(members);
  });

  test("stores a member uncompressed when its deflate output does not round-trip", () => {
    const chunks: Uint8Array[] = [];
    const corrupt = (data: Uint8Array) => (data.length > 100 ? new Uint8Array([0xff, 0xff, 0xff]) : new Uint8Array([3, 0]));
    writeArchiveToSink(members, chunk => chunks.push(chunk), corrupt);
    const zip = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((offset, c) => (zip.set(c, offset), offset + c.length), 0);
    expect(compressionMethods(zip)["EPUB/text.xhtml"]).toBe(0);
    expect(readArchive(zip)).toEqual(members);
  });

  test("stores a member uncompressed when the deflater throws", () => {
    const chunks: Uint8Array[] = [];
    writeArchiveToSink(members, chunk => chunks.push(chunk), () => { throw new Error("boom"); });
    const zip = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((offset, c) => (zip.set(c, offset), offset + c.length), 0);
    expect(Object.values(compressionMethods(zip)).every(m => m === 0)).toBe(true);
    expect(readArchive(zip)).toEqual(members);
  });

  // Real-library EPUBs exposed a corrupt-stream bug in fflate's streaming ZipDeflate.
  const library = resolve(process.env.BINDERY_PARITY_LIBRARY ?? "library");
  const epubs = existsSync(library)
    ? readdirSync(library).map(id => join(library, id, "book.epub")).filter(existsSync)
    : [];
  test.skipIf(!epubs.length).each(epubs)("round-trips every member of %s", { timeout: 120_000 }, path => {
    const original = readArchive(readFileSync(path));
    const rewritten = writeArchive(original);
    expect(() => unzipSync(rewritten)).not.toThrow();
    const reread = readArchive(rewritten);
    expect(reread.map(m => m.name)).toEqual(original.map(m => m.name));
    const mismatched = reread.filter((m, i) => !Buffer.from(m.data).equals(Buffer.from(original[i]!.data))).map(m => m.name);
    expect(mismatched).toEqual([]);
  });
});
