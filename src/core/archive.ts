import { deflateSync, inflateSync, unzipSync, Zip, ZipPassThrough } from "fflate";
export interface ArchiveMember {
  name: string;
  data: Uint8Array;
}
export type Deflater = (data: Uint8Array) => Uint8Array<ArrayBuffer>;
const defaultDeflater: Deflater = data => deflateSync(data, { level: 6 });
function inflatesTo(packed: Uint8Array, data: Uint8Array): boolean {
  try {
    const out = inflateSync(packed, { out: new Uint8Array(data.length) });
    if (out.length !== data.length) return false;
    for (let i = 0; i < data.length; i++) if (out[i] !== data[i]) return false;
    return true;
  } catch {
    return false;
  }
}
/**
 * One-shot deflate verified by a round trip. fflate's streaming ZipDeflate emits a
 * corrupt stream for some real EPUB members (seen on a 658 KB TTF font); a member whose
 * deflate output does not inflate back to the original is stored uncompressed instead.
 */
export class VerifiedZipDeflate extends ZipPassThrough {
  private readonly packed: Uint8Array<ArrayBuffer> | null;
  constructor(filename: string, data: Uint8Array, deflate: Deflater = defaultDeflater) {
    super(filename);
    let packed: Uint8Array<ArrayBuffer> | null = null;
    try {
      packed = deflate(data);
    } catch {
      packed = null;
    }
    this.packed = packed && inflatesTo(packed, data) ? packed : null;
    this.compression = this.packed ? 8 : 0;
  }
  protected override process(chunk: Uint8Array<ArrayBuffer>, final: boolean): void {
    this.ondata(null, this.packed ?? chunk, final);
  }
}
export function normpath(path: string): string {
  const absolute = path.startsWith("/"),
    parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push(part);
    } else parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/") || ".";
}
export const basename = (path: string): string =>
  path.replace(/\/+$/, "").split("/").at(-1) ?? "";
export const dirname = (path: string): string => {
  const normalized = normpath(path);
  const i = normalized.lastIndexOf("/");
  return i < 0 ? "." : normalized.slice(0, i) || "/";
};
export const extension = (path: string): string => {
  const name = basename(path);
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i) : "";
};
export function joinpath(base: string, path: string): string {
  return normpath(path.startsWith("/") ? path : `${base}/${path}`);
}
export function relativeHref(fromMember: string, toMember: string): string {
  const from = dirname(fromMember)
      .split("/")
      .filter((p) => p && p !== "."),
    to = normpath(toMember)
      .split("/")
      .filter((p) => p && p !== ".");
  let shared = 0;
  while (shared < from.length && from[shared] === to[shared]) shared++;
  return (
    [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/") ||
    "."
  );
}
export function canonicalZipMember(name: string): string {
  let normalized = normpath((name || "").replace(/\\/g, "/")).replace(
    /^\/+/,
    "",
  );
  while (normalized.startsWith("../")) normalized = normalized.slice(3);
  return normalized === "." ? "" : normalized;
}
/** Member names in central directory order, without inflating anything. */
export function archiveMemberNames(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Read central directory order explicitly (object enumeration reorders integer filenames).
  let end = data.length - 22;
  for (; end >= Math.max(0, data.length - 65557); end--)
    if (view.getUint32(end, true) === 0x06054b50) break;
  if (end < 0) throw new Error("Invalid ZIP central directory");
  let offset = view.getUint32(end + 16, true);
  const names: string[] = [],
    count = view.getUint16(end + 10, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("Invalid ZIP member");
    const length = view.getUint16(offset + 28, true),
      extra = view.getUint16(offset + 30, true),
      comment = view.getUint16(offset + 32, true);
    names.push(new TextDecoder().decode(
      data.subarray(offset + 46, offset + 46 + length),
    ));
    offset += 46 + length + extra + comment;
  }
  return names;
}
export function readArchive(data: Uint8Array): ArchiveMember[] {
  const members = unzipSync(data);
  return archiveMemberNames(data).map((name) => {
    const payload = members[name];
    if (!payload) throw new Error(`Unsupported ZIP filename encoding: ${name}`);
    return { name, data: payload };
  });
}
/** `deflate: null` stores every member, for intermediate archives that are re-packed right away. */
export function writeArchive(entries: Iterable<ArchiveMember>, deflate: Deflater | null = defaultDeflater): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  writeArchiveToSink(entries, data => {
    chunks.push(data);
    total += data.length;
  }, deflate);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
/** Synchronous sink provides backpressure (e.g. a complete write to a file descriptor). */
export function writeArchiveToSink(
  entries: Iterable<ArchiveMember>,
  write: (chunk: Uint8Array) => void,
  deflate: Deflater | null = defaultDeflater,
): void {
  const zip = new Zip((error, data) => {
    if (error) throw error;
    write(data);
  });
  try {
    for (const entry of entries) {
      const file = entry.name === "mimetype" || !deflate ? new ZipPassThrough(entry.name) : new VerifiedZipDeflate(entry.name, entry.data, deflate);
      zip.add(file);
      file.push(entry.data, true);
    }
    zip.end();
  } catch (error) { zip.terminate(); throw error; }
}
export interface ArchivePatch {
  data: Uint8Array;
  changed: boolean;
}
export function normalizeEpubArchivePaths(
  data: Uint8Array,
  expectedMissing = "",
): ArchivePatch {
  const entries = readArchive(data),
    expected = canonicalZipMember(expectedMissing);
  const mapped = entries.map((e) => {
    let name = canonicalZipMember(e.name);
    if (
      expected &&
      e.name.replace(/\\/g, "/").split("/").includes("..") &&
      basename(name) === basename(expected)
    )
      name = expected;
    return { ...e, name };
  });
  if (!mapped.some((e, i) => e.name !== entries[i].name))
    return { data, changed: false };
  const written = new Set<string>();
  return {
    changed: true,
    data: writeArchive(
      [...mapped.filter((e) => e.name === "mimetype"), ...mapped].filter(
        (e) => {
          if (!e.name || written.has(e.name)) return false;
          written.add(e.name);
          return true;
        },
      ),
    ),
  };
}
