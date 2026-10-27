import { ReaderArchive } from "../reader/archive";

/** Reuse the reader's ZIP/ZIP64 index and bounded native-zlib member reads.
 * Kept separate from the reader: no TOC/title discovery, shared LRU or CSS synchronization.
 */
export class CountArchive extends ReaderArchive {
  private packageDocument?: ReturnType<ReaderArchive["opf"]>;
  override opf(): ReturnType<ReaderArchive["opf"]> {
    return this.packageDocument ??= super.opf();
  }
  // A finite limit selects inflateRawSync and enforces the member's declared size.
  override read(path: string): Uint8Array | undefined {
    return super.read(path, this.members.get(path)?.size ?? 0);
  }
}
