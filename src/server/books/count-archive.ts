import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { ReaderArchive } from "../reader/archive";

const invalid = (): never => { throw new Error("Invalid or unsupported EPUB ZIP member"); };
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
/** Reuse the reader's ZIP/ZIP64 index, but inflate selected members with native zlib.
 * Kept separate from the reader: no TOC/title discovery, shared LRU or CSS synchronization.
 */
export class CountArchive extends ReaderArchive {
  private packageDocument?: ReturnType<ReaderArchive["opf"]>;
  override opf(): ReturnType<ReaderArchive["opf"]> {
    return this.packageDocument ??= super.opf();
  }
  override read(path: string): Uint8Array | undefined {
    const member = this.members.get(path);
    if (!member) return undefined;
    if (member.flags & 1 || ![0, 8].includes(member.method)) return invalid();
    const fd = openSync(this.path, "r");
    try {
      const current = fstatSync(fd, { bigint: true });
      if (current.size !== this.identity.size || current.mtimeNs !== this.identity.mtimeNs) throw new Error("EPUB changed while counting");
      const size = Number(current.size), header = readAt(fd, member.offset, 30, size);
      if (!Number.isSafeInteger(size) || header.readUInt32LE(0) !== 0x04034b50) return invalid();
      const start = member.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const packed = readAt(fd, start, member.compressedSize, size);
      const data = member.method === 8 ? inflateRawSync(packed, { maxOutputLength: member.size + 1 }) : packed;
      if (data.length !== member.size) return invalid();
      this.stats.memberReads++; this.stats.compressedBytesRead += packed.length;
      return data;
    } finally { closeSync(fd); }
  }
}
