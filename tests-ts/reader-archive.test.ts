import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";
import { writeArchive } from "../src/core/archive";
import { ReaderArchiveCache } from "../src/server/reader/archive";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function read(data: Uint8Array) {
  const root = mkdtempSync(join(tmpdir(), "bindery-index-")); roots.push(root);
  const path = join(root, "book.epub"); writeFileSync(path, data);
  return new ReaderArchiveCache().get(path)!;
}
const payload = new TextEncoder().encode("stored content");
function storedZip() { return Buffer.from(writeArchive([{ name: "mimetype", data: payload }])); }
function central(zip: Buffer) { return zip.readUInt32LE(zip.length - 22 + 16); }

it("reads stored, deflated, empty and data-descriptor members without unpacking siblings", () => {
  const entries = [
    { name: "mimetype", data: payload },
    { name: "Text/:|*.xhtml", data: new TextEncoder().encode("chapter ".repeat(1000)) },
    { name: "empty", data: new Uint8Array() },
    { name: "\ufeffe\u0301 #?.txt", data: payload },
  ];
  const archive = read(writeArchive(entries));
  expect(archive.members.get("mimetype")!.method).toBe(0);
  expect(archive.members.get("Text/:|*.xhtml")!.method).toBe(8);
  expect(archive.members.get("Text/:|*.xhtml")!.flags & 8).toBe(8);
  for (const entry of entries) expect(new Uint8Array(archive.read(entry.name)!)).toEqual(entry.data);
  expect(archive.stats.memberReads).toBe(4); expect(archive.read("missing")).toBeUndefined();
});

it("decodes legacy CP437 and honors a CRC-verified Unicode path extra field", () => {
  const zip = storedZip(), at = central(zip), legacy = Buffer.from([99, 97, 102, 130, 46, 112, 110, 103]);
  legacy.copy(zip, 30); legacy.copy(zip, at + 46);
  expect(read(zip).read("café.png")).toEqual(Buffer.from(payload));
  const unicode = Buffer.from("图 #?.png"), extra = Buffer.alloc(9 + unicode.length);
  extra.writeUInt16LE(0x7075); extra.writeUInt16LE(5 + unicode.length, 2); extra[4] = 1;
  extra.writeUInt32LE(crc32(legacy), 5); unicode.copy(extra, 9);
  const directory = Buffer.from(zip.subarray(at, zip.length - 22)), end = Buffer.from(zip.subarray(-22));
  directory.writeUInt16LE(extra.length, 30); end.writeUInt32LE(directory.length + extra.length, 12);
  const upgraded = Buffer.concat([zip.subarray(0, at), directory, extra, end]);
  expect(read(upgraded).read("图 #?.png")).toEqual(Buffer.from(payload));
  upgraded[at + directory.length + 5] ^= 1;
  const fallback = read(upgraded);
  expect(fallback.has("图 #?.png")).toBe(false); expect(fallback.read("café.png")).toEqual(Buffer.from(payload));
});

it("reads ZIP64 directory and per-member offsets/sizes", () => {
  const zip = storedZip(), at = central(zip), directory = Buffer.from(zip.subarray(at, zip.length - 22));
  const extra = Buffer.alloc(28); extra.writeUInt16LE(1); extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(payload.length), 4); extra.writeBigUInt64LE(BigInt(payload.length), 12); extra.writeBigUInt64LE(0n, 20);
  for (const field of [20, 24, 42]) directory.writeUInt32LE(0xffffffff, field);
  directory.writeUInt16LE(extra.length, 30);
  const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32);
  record.writeBigUInt64LE(BigInt(directory.length + extra.length), 40); record.writeBigUInt64LE(BigInt(at), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50);
  locator.writeBigUInt64LE(BigInt(at + directory.length + extra.length), 8); locator.writeUInt32LE(1, 16);
  const end = Buffer.from(zip.subarray(-22)); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  expect(read(Buffer.concat([zip.subarray(0, at), directory, extra, record, locator, end])).read("mimetype")).toEqual(Buffer.from(payload));
});

it("accepts ZIP comments containing a false EOCD signature", () => {
  const zip = storedZip(), comment = Buffer.alloc(40); comment.writeUInt32LE(0x06054b50);
  zip.writeUInt16LE(comment.length, zip.length - 2);
  expect(read(Buffer.concat([zip, comment])).read("mimetype")).toEqual(Buffer.from(payload));
});

it.each(["truncated", "directory", "local", "size", "offset", "encryption", "method"])("rejects malformed or unsupported ZIP fields: %s", kind => {
  let zip = storedZip(); const at = central(zip);
  if (kind === "truncated") zip = zip.subarray(0, 10);
  if (kind === "directory") zip[at] = 0;
  if (kind === "local") zip[0] = 0;
  if (kind === "size") zip.writeUInt32LE(payload.length + 1, at + 24);
  if (kind === "offset") zip.writeUInt32LE(zip.length, at + 42);
  if (kind === "encryption") zip.writeUInt16LE(1, at + 8);
  if (kind === "method") zip.writeUInt16LE(99, at + 10);
  expect(() => read(zip).read("mimetype")).toThrow("Invalid or unsupported EPUB ZIP archive");
});
