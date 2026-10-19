import { optionalDirectory, protectedEntry, type KindleDirectory } from "./fs";
import { listFonts, type FontFamily } from "./fonts";
import { readManifest, type ManifestBook } from "./manifest";
import type { PairedDevice } from "./identity";
import { withDeviceLock } from "./transaction";

export interface DeviceBook { filename: string; format: string; size: number; modifiedAt: number; sidecar: string | null; source: "Bindery" | "其他"; record: ManifestBook | null }
export interface DeviceInventory { books: DeviceBook[]; fonts: FontFamily[]; usage: { books: number; fonts: number; other: number; total: number; capacity: null; free: null } }
export const isBook = (name: string) => /\.(kfx|azw|azw3|txt)$/i.test(name) && !name.startsWith("._");
async function treeSize(root: KindleDirectory): Promise<number> {
  let size = 0;
  for await (const entry of root.values()) { if (protectedEntry(entry.name)) continue; size += entry.kind === "file" ? (await entry.getFile()).size : await treeSize(entry); }
  return size;
}
/** Enumerated bytes only; OS/calibre paths are skipped. FSA exposes no capacity/free-space API. */
export async function inventory(root: KindleDirectory): Promise<DeviceInventory> {
  const documents = await root.getDirectoryHandle("documents"), manifest = await readManifest(root);
  const records = new Map(manifest.books.map(b => [b.filename.toLowerCase(), b])), books: DeviceBook[] = [];
  let bookBytes = 0, other = 0;
  const visitDocuments = async (dir: KindleDirectory, prefix = "") => {
    const entries = []; for await (const entry of dir.values()) if (!protectedEntry(entry.name)) entries.push(entry);
    const sidecars = new Map(entries.filter(e => e.kind === "directory" && /\.sdr$/i.test(e.name)).map(e => [e.name.toLowerCase(), `${prefix}${e.name}`]));
    for (const entry of entries) {
      if (entry.kind === "directory") { if (/\.sdr$/i.test(entry.name)) other += await treeSize(entry); else await visitDocuments(entry, `${prefix}${entry.name}/`); continue; }
      const file = await entry.getFile(), filename = `${prefix}${entry.name}`;
      if (isBook(entry.name)) {
        const record = records.get(filename.toLowerCase()) ?? null; bookBytes += file.size;
        books.push({ filename, format: entry.name.split(".").at(-1)!.toLowerCase(), size: file.size, modifiedAt: file.lastModified, sidecar: sidecars.get(entry.name.replace(/\.[^.]+$/, ".sdr").toLowerCase()) ?? null, source: record ? "Bindery" : "其他", record });
      } else other += file.size;
    }
  };
  await visitDocuments(documents);
  const fonts = await listFonts(root), fontBytes = fonts.reduce((sum, f) => sum + f.size, 0);
  const fontDir = await optionalDirectory(root, "fonts"); if (fontDir) other += Math.max(0, await treeSize(fontDir) - fontBytes);
  const system = await root.getDirectoryHandle("system"), thumbs = await optionalDirectory(system, "thumbnails");
  if (thumbs) other += await treeSize(thumbs);
  try { other += (await (await system.getFileHandle("version.txt")).getFile()).size; } catch (error) { if (!(error instanceof Error && error.name === "NotFoundError")) throw error; await root.getDirectoryHandle("documents"); }
  const internal = await optionalDirectory(root, ".bindery"); if (internal) other += await treeSize(internal);
  for await (const entry of root.values()) if (entry.kind === "file" && !protectedEntry(entry.name)) other += (await entry.getFile()).size;
  return { books: books.sort((a, b) => a.filename.localeCompare(b.filename)), fonts, usage: { books: bookBytes, fonts: fontBytes, other, total: bookBytes + fontBytes + other, capacity: null, free: null } };
}
/** Preferred UI entry: waits for active mutations and recovers interrupted transactions. */
export const deviceInventory = (device: PairedDevice) => withDeviceLock(device, () => inventory(device.root));
