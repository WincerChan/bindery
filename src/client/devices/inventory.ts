import { assertReachable, directoryEntries, EntryReader, entryOperation, optionalDirectory, optionalEntry, protectedEntry, type DeviceDirectory, type UnreadableEntry } from "./fs";
import { listFonts, type FontFamily } from "./fonts";
import { assertDevice, type PairedDevice } from "./identity";
import type { DeviceKind } from "./models";
import { readManifest, type ManifestBook } from "../kindle/manifest";
import { withDeviceLock } from "./transaction";

export interface DeviceBookRecord { book_id: string; profile_id: string; profile_name: string; transferred_at: string; thumbnail: string | null }
export interface DeviceBook {
  /** Device-relative path, e.g. `documents/name.kfx` or `Bindery/name.kepub.epub`. */
  filename: string;
  format: string;
  size: number;
  modifiedAt: number;
  sidecar: string | null;
  source: "Bindery" | "其他";
  record: ManifestBook | null;
}
export interface DeviceInventory { books: DeviceBook[]; fonts: FontFamily[]; unreadable: UnreadableEntry[]; unreadableCount: number; usage: { books: number; fonts: number; other: number; total: number; capacity: null; free: null } }
export const isBook = (name: string) => /\.(kfx|azw|azw3|txt)$/i.test(name) && !name.startsWith("._");
export const isKoboBook = (name: string) => /\.(?:epub|kepub\.epub)$/i.test(name) && !name.startsWith("._");
const formatOf = (name: string) => name.toLowerCase().endsWith(".kepub.epub") ? "kepub" : name.split(".").at(-1)!.toLowerCase();
const isBindery = (filename: string) => filename.split("/")[0]?.toLowerCase() === "bindery";

async function treeSize(reader: EntryReader, dir: DeviceDirectory, path: string, counted = new Set<string>()): Promise<number> {
  let size = 0;
  const entries = await reader.read(path, () => directoryEntries(reader.root, dir, path, reader.kind));
  for (const entry of entries ?? []) {
    if (protectedEntry(entry.name)) continue;
    const full = `${path}/${entry.name}`;
    if (counted.has(full)) continue;
    size += entry.kind === "file" ? (await reader.read(full, () => entry.getFile()))?.size ?? 0 : await treeSize(reader, entry, full, counted);
  }
  return size;
}
/** Kindle inventory: documents/ books, manifest-backed Bindery copies, fonts and enumerated usage. */
async function kindleInventory(root: DeviceDirectory, unreadable: UnreadableEntry[] = []): Promise<DeviceInventory> {
  await assertReachable(root);
  const reader = new EntryReader(root, unreadable), documents = await entryOperation(root, "documents", () => root.getDirectoryHandle("documents"));
  const manifest = await reader.read(".bindery/manifest.json", () => readManifest(root));
  const records = new Map(manifest?.books.map(b => [b.filename.toLowerCase(), b])), books: DeviceBook[] = [];
  let bookBytes = 0, other = 0;
  const visitDocuments = async (dir: DeviceDirectory, prefix = "") => {
    const dirPath = `documents/${prefix}`.replace(/\/$/, "");
    const entries = (await reader.read(dirPath, () => directoryEntries(root, dir, dirPath)))?.filter(e => !protectedEntry(e.name)) ?? [];
    const sidecars = new Map(entries.filter(e => e.kind === "directory" && /\.sdr$/i.test(e.name)).map(e => [e.name.toLowerCase(), `${prefix}${e.name}`]));
    for (const entry of entries) {
      const filename = `${prefix}${entry.name}`, full = `documents/${filename}`;
      if (entry.kind === "directory") { if (/\.sdr$/i.test(entry.name)) other += await treeSize(reader, entry, full); else await visitDocuments(entry, `${filename}/`); continue; }
      const file = await reader.read(full, () => entry.getFile());
      if (!file) continue;
      if (isBook(entry.name)) {
        const record = records.get(filename.toLowerCase()) ?? null; bookBytes += file.size;
        books.push({ filename, format: entry.name.split(".").at(-1)!.toLowerCase(), size: file.size, modifiedAt: file.lastModified, sidecar: sidecars.get(entry.name.replace(/\.[^.]+$/, ".sdr").toLowerCase()) ?? null, source: record ? "Bindery" : "其他", record });
      } else other += file.size;
    }
  };
  await visitDocuments(documents);
  const fonts = await listFonts(root, reader), fontBytes = fonts.reduce((sum, f) => sum + f.size, 0);
  const countedFonts = new Set(fonts.flatMap(f => f.fonts.map(font => `fonts/${font.filename}`)));
  const fontDir = await reader.read("fonts", () => optionalDirectory(root, "fonts")); if (fontDir) other += await treeSize(reader, fontDir, "fonts", countedFonts);
  const system = await reader.read("system", () => root.getDirectoryHandle("system"));
  if (system) {
    const thumbs = await reader.read("system/thumbnails", () => optionalDirectory(system, "thumbnails", root, "system"));
    if (thumbs) other += await treeSize(reader, thumbs, "system/thumbnails");
    const version = await reader.read("system/version.txt", () => optionalEntry(root, system, "version.txt", "system"));
    if (version?.kind === "file") other += (await reader.read("system/version.txt", () => version.getFile()))?.size ?? 0;
  }
  const internal = await reader.read(".bindery", () => optionalDirectory(root, ".bindery")); if (internal) other += await treeSize(reader, internal, ".bindery");
  const entries = await reader.read("", () => directoryEntries(root, root, ""));
  for (const entry of entries ?? []) if (entry.kind === "file" && !protectedEntry(entry.name)) other += (await reader.read(entry.name, () => entry.getFile()))?.size ?? 0;
  return { books: books.sort((a, b) => a.filename.localeCompare(b.filename)), fonts, unreadable: reader.unreadable, unreadableCount: reader.unreadable.length, usage: { books: bookBytes, fonts: fontBytes, other, total: bookBytes + fontBytes + other, capacity: null, free: null } };
}

const skipKoboDirectory = (name: string) => protectedEntry(name) || [".kobo", ".bindery", "fonts", "system"].includes(name.toLowerCase());
/** Kobo inventory: every EPUB/KEPUB outside the system folders; Bindery/ marks managed files. */
async function koboInventory(root: DeviceDirectory, unreadable: UnreadableEntry[] = []): Promise<DeviceInventory> {
  await assertReachable(root, "kobo");
  const reader = new EntryReader(root, unreadable, "kobo"), books: DeviceBook[] = [];
  let bookBytes = 0, other = 0;
  const visit = async (dir: DeviceDirectory, prefix: string) => {
    const path = prefix.replace(/\/$/, "");
    const entries = (await reader.read(path, () => directoryEntries(root, dir, path, "kobo")))?.filter(entry => !skipKoboDirectory(entry.name)) ?? [];
    for (const entry of entries) {
      const filename = prefix ? `${prefix}${entry.name}` : entry.name;
      if (entry.kind === "directory") { await visit(entry, `${filename}/`); continue; }
      const file = await reader.read(filename, () => entry.getFile()); if (!file) continue;
      if (isKoboBook(entry.name)) {
        bookBytes += file.size;
        books.push({ filename, format: formatOf(entry.name), size: file.size, modifiedAt: file.lastModified, sidecar: null, source: isBindery(filename) ? "Bindery" : "其他", record: null });
      } else other += file.size;
    }
  };
  await visit(root, "");
  const fonts = await listFonts(root, new EntryReader(root, unreadable, "kobo"), "kobo"), fontBytes = fonts.reduce((sum, f) => sum + f.size, 0);
  return { books: books.sort((a, b) => a.filename.localeCompare(b.filename)), fonts, unreadable: reader.unreadable, unreadableCount: reader.unreadable.length, usage: { books: bookBytes, fonts: fontBytes, other, total: bookBytes + fontBytes + other, capacity: null, free: null } };
}
export async function inventory(root: DeviceDirectory, kind: DeviceKind = "kindle", unreadable: UnreadableEntry[] = []): Promise<DeviceInventory> {
  return kind === "kobo" ? koboInventory(root, unreadable) : kindleInventory(root, unreadable);
}
/** Preferred UI entry: waits for active mutations and recovers interrupted transactions. */
export const deviceInventory = (device: PairedDevice) => {
  const unreadable: UnreadableEntry[] = [];
  return withDeviceLock(device, () => inventory(device.root, device.identity.kind, unreadable), { readOnly: true, onUnreadable: issue => unreadable.push(issue) });
};
export { assertDevice };
