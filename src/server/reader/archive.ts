import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { inflateSync } from "fflate";
import { parseEpubPackage, type EpubSource } from "../../core/epub";
import { isSafeEpubPath, resolveEpubReference } from "../../core/epub-path";
import { attr, descendants, parseXml } from "../../core/xml";

interface ZipMember { offset: number; compressedSize: number; size: number; method: number; flags: number }
const invalid = (): never => { throw new Error("Invalid or unsupported EPUB ZIP archive"); };
const safeNumber = (value: bigint) => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : invalid();
const cp437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function zipName(bytes: Uint8Array, flags: number): string {
  // Also tolerate producers writing UTF-8 without the language-encoding flag.
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { if (flags & 0x800) return invalid(); }
  return Array.from(bytes, byte => byte < 128 ? String.fromCharCode(byte) : cp437[byte - 128]).join("");
}
function readAt(fd: number, offset: number, size: number, fileSize: number): Buffer {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > fileSize) return invalid();
  const data = Buffer.allocUnsafe(size);
  for (let done = 0; done < size;) {
    const count = readSync(fd, data, done, size - done, offset + done);
    if (!count) return invalid();
    done += count;
  }
  return data;
}

/** Only the central directory stays resident; no archive bytes or inflated chapters are retained. */
export class ReaderArchive implements EpubSource {
  readonly members = new Map<string, ZipMember>();
  readonly stats = { indexBuilds: 1, metadataParses: 0, memberReads: 0, compressedBytesRead: 0 };
  private parsed?: ReturnType<typeof parseEpubPackage>;
  private mediaTypes?: Map<string, string>;
  private checkedCss?: string;
  weight = 0;
  constructor(readonly path: string, readonly identity: BigIntStats, private readonly resized: () => void) {
    const fd = openSync(path, "r"), fileSize = safeNumber(identity.size);
    try {
      const tailOffset = Math.max(0, fileSize - 65557), tail = readAt(fd, tailOffset, fileSize - tailOffset, fileSize);
      let end = tail.length - 22;
      for (; end >= 0; end--) if (tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length) break;
      if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) return invalid();
      let count = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
      if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
        const locator = readAt(fd, tailOffset + end - 20, 20, fileSize);
        if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) return invalid();
        const record = readAt(fd, safeNumber(locator.readBigUInt64LE(8)), 56, fileSize);
        if (record.readUInt32LE(0) !== 0x06064b50 || record.readUInt32LE(16) || record.readUInt32LE(20)) return invalid();
        count = safeNumber(record.readBigUInt64LE(32)); size = safeNumber(record.readBigUInt64LE(40)); offset = safeNumber(record.readBigUInt64LE(48));
      }
      const directory = readAt(fd, offset, size, fileSize);
      for (let i = 0, at = 0; i < count; i++) {
        if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) return invalid();
        const flags = directory.readUInt16LE(at + 8), method = directory.readUInt16LE(at + 10);
        const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32);
        const next = at + 46 + nameLength + extraLength + commentLength;
        if (next > directory.length) return invalid();
        const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
        let name = zipName(nameBytes, flags);
        const member: ZipMember = { flags, method, size: directory.readUInt32LE(at + 24), compressedSize: directory.readUInt32LE(at + 20), offset: directory.readUInt32LE(at + 42) };
        for (let extra = at + 46 + nameLength; extra + 4 <= next - commentLength;) {
          const tag = directory.readUInt16LE(extra), length = directory.readUInt16LE(extra + 2), start = extra + 4;
          if (start + length > next - commentLength) return invalid();
          if (tag === 1) {
            let field = start;
            for (const key of ["size", "compressedSize", "offset"] as const) if (member[key] === 0xffffffff) {
              if (field + 8 > start + length) return invalid();
              member[key] = safeNumber(directory.readBigUInt64LE(field)); field += 8;
            }
          }
          // Info-ZIP's Unicode path extra field (version + filename CRC + UTF-8).
          if (tag === 0x7075 && length >= 5 && directory[start] === 1 && directory.readUInt32LE(start + 1) === crc32(nameBytes)) name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(directory.subarray(start + 5, start + length));
          extra = start + length;
        }
        if (isSafeEpubPath(name)) this.members.set(name, member);
        this.weight += 128 + name.length * 2;
        at = next;
      }
    } finally { closeSync(fd); }
  }
  has = (path: string): boolean => this.members.has(path);
  resolve(from: string, href: string): string { return resolveEpubReference(from, href, this.has)?.path ?? ""; }
  read(path: string): Uint8Array | undefined {
    const member = this.members.get(path);
    if (!member) return undefined;
    if (member.flags & 1 || ![0, 8].includes(member.method)) return invalid();
    const fd = openSync(this.path, "r");
    try {
      const current = fstatSync(fd, { bigint: true });
      if (current.size !== this.identity.size || current.mtimeNs !== this.identity.mtimeNs) throw new Error("EPUB changed while reading; retry the request");
      const size = safeNumber(current.size), header = readAt(fd, member.offset, 30, size);
      if (header.readUInt32LE(0) !== 0x04034b50) return invalid();
      const start = member.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const packed = readAt(fd, start, member.compressedSize, size);
      this.stats.memberReads++; this.stats.compressedBytesRead += packed.length;
      const data = member.method === 8 ? inflateSync(packed) : packed;
      if (data.length !== member.size) return invalid();
      return data;
    } finally { closeSync(fd); }
  }
  opf(): ReturnType<EpubSource["opf"]> {
    const container = this.read("META-INF/container.xml");
    if (!container) throw new Error("Missing META-INF/container.xml");
    const root = parseXml(container), rootfile = [root, ...descendants(root, "rootfile")].find(node => node.localName === "rootfile" && attr(node, "full-path"));
    const raw = rootfile ? attr(rootfile, "full-path") : "";
    const path = this.has(raw) ? raw : this.resolve("container.xml", raw), data = this.read(path);
    if (!data) throw new Error("Missing EPUB package document");
    return [path, parseXml(data)];
  }
  metadata(): ReturnType<typeof parseEpubPackage> {
    if (!this.parsed) {
      this.stats.metadataParses++;
      this.parsed = parseEpubPackage(this);
      this.mediaTypes = new Map(this.parsed.items.map(item => [item.member_path, item.media_type]));
      this.weight += JSON.stringify(this.parsed).length * 2;
      this.resized();
    }
    return this.parsed;
  }
  mediaType(path: string): string | undefined { this.metadata(); return this.mediaTypes!.get(path); }
  retainMetadata(bytes: number): void { this.weight += bytes; this.resized(); }
  cssChecked(css: string): boolean { return this.checkedCss === css; }
  markCssChecked(css: string): void {
    // One effective CSS value per archive identity, bounded even with repeated edits.
    this.weight += (css.length - (this.checkedCss?.length ?? 0)) * 2;
    this.checkedCss = css; this.resized();
  }
}

/** Byte- and entry-bounded LRU. Replaced files discard both the ZIP index and parsed package. */
export class ReaderArchiveCache {
  private entries = new Map<string, ReaderArchive>();
  constructor(readonly maxBytes = 32 * 1024 * 1024, readonly maxEntries = 16) {}
  get(path: string): ReaderArchive | undefined {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    const previous = this.entries.get(path);
    this.entries.delete(path);
    if (!stat?.isFile()) return undefined;
    const archive = previous?.identity.size === stat.size && previous.identity.mtimeNs === stat.mtimeNs ? previous : new ReaderArchive(path, stat, () => this.trim());
    this.entries.set(path, archive); this.trim();
    return archive;
  }
  private trim(): void {
    let bytes = [...this.entries.values()].reduce((total, archive) => total + archive.weight, 0);
    while (this.entries.size > this.maxEntries || bytes > this.maxBytes) {
      const key = this.entries.keys().next().value!;
      bytes -= this.entries.get(key)!.weight; this.entries.delete(key);
    }
  }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}
export const readerArchives = new ReaderArchiveCache();
