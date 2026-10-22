import { directoryEntries, documentPath, EntryAccessError, entryOperation, optionalEntry, protectedEntry, type KindleDirectory, type UnreadableEntry } from "./fs";
import type { PairedDevice } from "./identity";
import { isBook } from "./inventory";
import type { DeviceKind } from "./models";
import { manifestBytes, readManifest } from "../kindle/manifest";
import { koboManifestBytes, readKoboManifest, withoutKoboManifestBook } from "./kobo/manifest";
import { applyDevicePatchesFor, validateDevicePath, withDeviceLock, type DevicePatch } from "./transaction";

export interface DeleteBookReport { filename: string; removed: true; notRemoved: UnreadableEntry[] }
/** Best effort cleanup never reads file contents or backs sidecars up under another long path. */
async function removeTree(root: KindleDirectory, parent: KindleDirectory, name: string, prefix: string, failures: UnreadableEntry[]): Promise<boolean> {
  const path = `${prefix}/${name}`;
  try {
    const entry = await optionalEntry(root, parent, name, prefix); if (!entry) return true;
    if (entry.kind === "directory") {
      let entries;
      try { entries = await directoryEntries(root, entry, path); }
      catch (error) {
        if (!(error instanceof EntryAccessError)) throw error;
        // Enumeration may be denied even when deleting the directory is permitted.
        await entryOperation(root, path, () => parent.removeEntry(name, { recursive: true })); return true;
      }
      let empty = true;
      for (const child of entries) {
        if (protectedEntry(child.name)) { empty = false; continue; }
        if (!await removeTree(root, entry, child.name, path, failures)) empty = false;
      }
      if (!empty) return false;
    }
    await entryOperation(root, path, () => parent.removeEntry(name));
    return true;
  } catch (error) {
    if (!(error instanceof EntryAccessError)) throw error;
    failures.push(error.issue); return false;
  }
}

/** Finds one book and its .sdr sidecar by listing only the folders on its path, not the whole device. */
async function locateBook(root: KindleDirectory, parts: string[], kind: DeviceKind) {
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const entry = await optionalEntry(root, dir, parts[i], parts.slice(0, i).join("/"), kind);
    if (!entry || entry.kind !== "directory") return null;
    dir = entry;
  }
  const entries = await directoryEntries(root, dir, parts.slice(0, -1).join("/"), kind);
  const file = entries.find(entry => entry.kind === "file" && entry.name === parts.at(-1));
  if (!file) return null;
  const sidecarName = file.name.replace(/\.[^.]+$/, ".sdr").toLowerCase();
  const sidecar = entries.find(entry => entry.kind === "directory" && entry.name.toLowerCase() === sidecarName);
  return { sidecar: sidecar ? [...parts.slice(0, -1), sidecar.name] : null };
}
export async function deleteBook(device: PairedDevice, filename: string) {
  if (device.identity.kind === "kobo") return deleteKoboBook(device, filename);
  const path = documentPath(filename); if (!isBook(path.at(-1)!)) throw new Error("只能删除 documents 中的书籍文件");
  return withDeviceLock(device, async () => {
    const book = await locateBook(device.root, ["documents", ...path], "kindle");
    if (!book) throw new Error("设备书籍不存在");
    const manifest = await readManifest(device.root), record = manifest.books.find(b => b.filename.toLowerCase() === filename.toLowerCase()) ?? null;
    manifest.books = manifest.books.filter(b => b.filename.toLowerCase() !== filename.toLowerCase());
    const patches: DevicePatch[] = [{ path: ["documents", ...path], data: null }];
    patches.push({ path: [".bindery", "manifest.json"], data: manifestBytes(manifest) });
    await applyDevicePatchesFor(device.root, "kindle", patches);
    // Commit the book + manifest together first; inaccessible sidecars cannot undo deletion.
    const report: DeleteBookReport = { filename, removed: true, notRemoved: [] };
    const cleanup = async (parts: string[]) => {
      try {
        let parent = device.root;
        for (let i = 0; i < parts.length - 1; i++) {
          const current = parent;
          const entry = await optionalEntry(device.root, current, parts[i], parts.slice(0, i).join("/"));
          if (!entry) return;
          if (entry.kind !== "directory") throw new Error("预期文件夹");
          parent = entry;
        }
        await removeTree(device.root, parent, parts.at(-1)!, parts.slice(0, -1).join("/"), report.notRemoved);
      } catch (error) { if (!(error instanceof EntryAccessError)) throw error; report.notRemoved.push(error.issue); }
    };
    if (book.sidecar) await cleanup(book.sidecar);
    if (record?.thumbnail && !manifest.books.some(b => b.thumbnail === record.thumbnail)) await cleanup(["system", "thumbnails", record.thumbnail]);
    return report;
  });
}

async function deleteKoboBook(device: PairedDevice, filename: string): Promise<DeleteBookReport> {
  const parts = filename.split("/");
  validateDevicePath(parts, "kobo");
  if (parts[0] !== "Bindery" || !/\.kepub\.epub$/i.test(parts.at(-1)!)) throw new Error("只能删除 Bindery 中的 KEPUB 文件");
  return withDeviceLock(device, async () => {
    if (!await locateBook(device.root, parts, "kobo")) throw new Error("设备书籍不存在");
    const manifest = await readKoboManifest(device.root), next = withoutKoboManifestBook(manifest, filename);
    const patches: DevicePatch[] = [{ path: parts, data: null }];
    if (next.books.length !== manifest.books.length) patches.push({ path: [".bindery", "manifest.json"], data: koboManifestBytes(next) });
    await applyDevicePatchesFor(device.root, "kobo", patches);
    return { filename, removed: true, notRemoved: [] };
  });
}
