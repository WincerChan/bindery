import type { KindleEntry } from "../../server/reading/input";
import { directoryEntries, entryOperation, type DeviceDirectory, type DeviceFile, type KindleDirectory } from "./fs";
import { kindlePosition, readKfxPositions, type KindlePositions } from "./kfx-positions";
import { decodeKindlePosition, parseReaderDataStore } from "./reading-store";
import type { DeviceManifest, ManifestBook } from "./manifest";

export interface KindleReading {
  entries: KindleEntry[];
  /** Manifest books whose sidecar or KFX could not be read; the pass continues. */
  skipped: number;
  /** Sidecars on the device that do not belong to a manifest book. */
  unmatched: number;
}
interface CachedPositions { size: number; modified: number; positions: KindlePositions }
let caches = new WeakMap<KindleDirectory, Map<string, CachedPositions>>();
export function clearKindlePositionCache(root?: KindleDirectory) {
  if (root) caches.delete(root);
  else caches = new WeakMap();
}
interface LastRead { location: string; at: string; when: bigint }
function lastRead(store: ReturnType<typeof parseReaderDataStore>): LastRead | null {
  const lpr = store.fields.get("lpr");
  if (!lpr || lpr.length < 3 || typeof lpr[1] !== "string" || typeof lpr[2] !== "bigint" || lpr[2] < 0n || lpr[2] > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const date = new Date(Number(lpr[2]));
  return Number.isFinite(date.getTime()) ? { location: lpr[1], at: date.toISOString(), when: lpr[2] } : null;
}
async function readSidecar(root: KindleDirectory, dir: DeviceDirectory, path: string): Promise<LastRead | null> {
  let newest: LastRead | null = null;
  for (const entry of await directoryEntries(root, dir, path)) {
    if (entry.kind !== "file" || !/\.yjf$/i.test(entry.name)) continue;
    try {
      const bytes = await entryOperation(root, `${path}/${entry.name}`, async () => new Uint8Array(await (await entry.getFile()).arrayBuffer()));
      const value = lastRead(parseReaderDataStore(bytes));
      if (value && (!newest || value.when > newest.when)) newest = value;
    } catch { /* A damaged sidecar must not hide the other one. */ }
  }
  return newest;
}
async function cachedPositions(root: KindleDirectory, filename: string, file: DeviceFile): Promise<KindlePositions> {
  const snapshot = await file.getFile(), cache = caches.get(root) ?? new Map<string, CachedPositions>(), key = filename.toLowerCase();
  caches.set(root, cache);
  const previous = cache.get(key);
  if (previous && previous.size === snapshot.size && previous.modified === snapshot.lastModified) return previous.positions;
  const positions = await readKfxPositions(snapshot);
  cache.set(key, { size: snapshot.size, modified: snapshot.lastModified, positions });
  return positions;
}
const chapterCount = (positions: KindlePositions) => positions.chapters.reduce((count, chapter) => Math.max(count, chapter.index + 1), 0);

/** Read-only pass over a Kindle: sidecars are never written and failures are counted per book. */
export async function readKindleReading(root: KindleDirectory, manifest: DeviceManifest): Promise<KindleReading> {
  const documents = await entryOperation(root, "documents", () => root.getDirectoryHandle("documents"));
  const entries = await directoryEntries(root, documents, "documents");
  const files = new Map(entries.filter((entry): entry is DeviceFile => entry.kind === "file").map(entry => [entry.name.toLowerCase(), entry]));
  const sidecars = new Map(entries.filter((entry): entry is DeviceDirectory => entry.kind === "directory" && /\.sdr$/i.test(entry.name)).map(entry => [entry.name.toLowerCase(), entry]));
  const consumed = new Set<string>(), result: KindleEntry[] = [];
  let skipped = 0;
  for (const book of manifest.books) {
    try {
      const entry = await readBook(root, files, sidecars, consumed, book);
      if (entry) result.push(entry); else skipped++;
    } catch { skipped++; }
  }
  return { entries: result, skipped, unmatched: [...sidecars.keys()].filter(name => !consumed.has(name)).length };
}
async function readBook(root: KindleDirectory, files: Map<string, DeviceFile>, sidecars: Map<string, DeviceDirectory>, consumed: Set<string>, book: ManifestBook): Promise<KindleEntry | null> {
  const stem = book.filename.replace(/\.kfx$/i, "");
  const candidates = [`${stem}.sdr`, `${stem}_${book.content_id}.sdr`].map(name => name.toLowerCase());
  const dirs: Array<[string, DeviceDirectory]> = [];
  for (const name of candidates) {
    const dir = sidecars.get(name);
    if (dir) { consumed.add(name); dirs.push([`documents/${dir.name}`, dir]); }
  }
  if (!dirs.length) return null;
  let newest: LastRead | null = null;
  for (const [path, dir] of dirs) {
    const value = await readSidecar(root, dir, path);
    if (value && (!newest || value.when > newest.when)) newest = value;
  }
  if (!newest) return null;
  const decoded = decodeKindlePosition(newest.location), file = files.get(book.filename.toLowerCase());
  if (!file) return null;
  const positions = await cachedPositions(root, book.filename, file), position = kindlePosition(positions, decoded);
  return {
    book_id: book.book_id, location: newest.location, chapter: position.chapter, chapter_count: chapterCount(positions),
    chapter_fraction: position.chapter_fraction, percent: position.percent, last_read_at: newest.at,
  };
}
