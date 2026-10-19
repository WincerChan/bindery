import { documentPath } from "./fs";
import type { PairedDevice } from "./identity";
import { inventory, isBook } from "./inventory";
import { manifestBytes, readManifest } from "./manifest";
import { applyDevicePatches, withDeviceLock, type DevicePatch } from "./transaction";

export async function deleteBook(device: PairedDevice, filename: string) {
  const path = documentPath(filename); if (!isBook(path.at(-1)!)) throw new Error("只能删除 documents 中的书籍文件");
  return withDeviceLock(device, async () => {
    const book = (await inventory(device.root)).books.find(b => b.filename === filename);
    if (!book) throw new Error("设备书籍不存在");
    const manifest = await readManifest(device.root), record = book.record;
    manifest.books = manifest.books.filter(b => b.filename.toLowerCase() !== filename.toLowerCase());
    const patches: DevicePatch[] = [{ path: ["documents", ...path], data: null }];
    if (book.sidecar) patches.push({ path: ["documents", ...documentPath(book.sidecar)], data: null });
    if (record?.thumbnail && !manifest.books.some(b => b.thumbnail === record.thumbnail)) patches.push({ path: ["system", "thumbnails", record.thumbnail], data: null });
    patches.push({ path: [".bindery", "manifest.json"], data: manifestBytes(manifest) });
    await applyDevicePatches(device.root, patches);
  });
}
