import { documentPath, entryName, isMissing, readJson, removeIfPresent, writeBytes, type KindleDirectory, type KindleFile } from "./fs";
import { assertDevice, type PairedDevice } from "./identity";

const locks = new Map<string, Promise<unknown>>();
export async function withDeviceLock<T>(device: PairedDevice, action: () => Promise<T>): Promise<T> {
  const id = device.identity.id, previous = locks.get(id) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const execute = async () => { await assertDevice(device); await recoverDevice(device.root); return action(); };
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(`bindery-kindle-${id}`, execute);
    return execute();
  });
  locks.set(id, run);
  try { return await run; } finally { if (locks.get(id) === run) locks.delete(id); }
}
export interface DevicePatch { path: string[]; data: Uint8Array<ArrayBuffer> | string | null }
interface Backup { path: string[]; kind: "file" | "directory" | null }
interface Journal { version: 1; committed: boolean; backups: Backup[] }
function validatePath(path: unknown): asserts path is string[] {
  if (!Array.isArray(path) || !path.every(p => typeof p === "string" && entryName(p) === p)) throw new Error("无效的设备事务路径");
  const [dir, name] = path;
  const documents = dir === "documents" && path.length >= 2 && documentPath(path.slice(1).join("/")).length === path.length - 1 && /\.(kfx|azw|azw3|txt|sdr)$/i.test(path.at(-1)!);
  const allowed = documents || path.length === 2 && (dir === "fonts" && /\.(ttf|otf)$/i.test(name) && !name.startsWith("._") || dir === ".bindery" && name === "manifest.json") || path.length === 3 && dir === "system" && name === "thumbnails" && /^thumbnail_[\w-]+_(EBOK|PDOC)_portrait\.jpg$/.test(path[2]);
  if (!allowed) throw new Error("拒绝访问 Kindle 受保护路径");
}
async function parent(root: KindleDirectory, path: string[], create = false) {
  let dir = root;
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
  return { dir, name: path.at(-1)! };
}
async function lookup(root: KindleDirectory, name: string): Promise<KindleDirectory | KindleFile | null> {
  try { return await root.getFileHandle(name); } catch (error) {
    if (isMissing(error)) return null;
    if (!(error instanceof Error && error.name === "TypeMismatchError")) throw error;
    return root.getDirectoryHandle(name);
  }
}
async function copy(source: KindleDirectory | KindleFile, destination: KindleDirectory, name: string) {
  if (source.kind === "file") { await writeBytes(destination, name, new Uint8Array(await (await source.getFile()).arrayBuffer())); return; }
  const dir = await destination.getDirectoryHandle(name, { create: true });
  for await (const entry of source.values()) await copy(entry, dir, entry.name);
}
/** Recover a prior interrupted mutation before any new write. Journal/backup remain on unplug. */
export async function recoverDevice(root: KindleDirectory) {
  await root.getDirectoryHandle("documents");
  let internal: KindleDirectory;
  try { internal = await root.getDirectoryHandle(".bindery"); } catch (error) { if (isMissing(error)) { await root.getDirectoryHandle("documents"); return; } throw error; }
  let journal: Journal;
  try { journal = await readJson(internal, "pending.json") as Journal; }
  catch (error) { if (isMissing(error)) { await root.getDirectoryHandle("documents"); return; } throw new Error("设备恢复日志损坏，请保留 .bindery 并检查设备", { cause: error }); }
  if (!journal || journal.version !== 1 || typeof journal.committed !== "boolean" || !Array.isArray(journal.backups)) throw new Error("设备恢复日志损坏");
  for (const b of journal.backups) { validatePath(b.path); if (![null, "file", "directory"].includes(b.kind)) throw new Error("设备恢复日志损坏"); }
  if (!journal.committed) {
    const backup = await internal.getDirectoryHandle("rollback");
    // Verify all backup entries exist before removing any destination.
    for (let i = 0; i < journal.backups.length; i++) if (journal.backups[i].kind && !(await lookup(backup, String(i)))) throw new Error("设备恢复备份不完整，请检查 .bindery/rollback");
    for (let i = journal.backups.length - 1; i >= 0; i--) {
      const b = journal.backups[i], target = await parent(root, b.path, true);
      await removeIfPresent(target.dir, target.name, true);
      if (b.kind) await copy((await lookup(backup, String(i)))!, target.dir, target.name);
    }
  }
  // Remove journal first: committed writes/finished rollback no longer require the backup.
  await removeIfPresent(internal, "pending.json");
  await removeIfPresent(internal, "rollback", true);
}
/** Caller holds withDeviceLock. Backups + journal precede any target change; manifest is last. */
export async function applyDevicePatches(root: KindleDirectory, patches: DevicePatch[], signal?: AbortSignal) {
  const check = () => { if (signal?.aborted) throw new DOMException("操作已取消", "AbortError"); };
  check();
  for (const patch of patches) validatePath(patch.path);
  if (new Set(patches.map(p => p.path.join("/").toLowerCase())).size !== patches.length) throw new Error("设备事务包含重复路径");
  const internal = await root.getDirectoryHandle(".bindery", { create: true });
  await removeIfPresent(internal, "rollback", true);
  const backup = await internal.getDirectoryHandle("rollback", { create: true }), journal: Journal = { version: 1, committed: false, backups: [] };
  for (let i = 0; i < patches.length; i++) {
    check(); const patch = patches[i], target = await parent(root, patch.path, true), current = await lookup(target.dir, target.name);
    if (current?.kind === "directory" && patch.data !== null) throw new Error("目标文件名已被文件夹占用");
    if (current) await copy(current, backup, String(i));
    journal.backups.push({ path: patch.path, kind: current?.kind ?? null });
  }
  await writeBytes(internal, "pending.json", JSON.stringify(journal));
  try {
    for (const patch of patches) {
      check(); const target = await parent(root, patch.path, true);
      if (patch.data === null) await removeIfPresent(target.dir, target.name, true);
      else await writeBytes(target.dir, target.name, patch.data);
    }
    check(); journal.committed = true;
    await writeBytes(internal, "pending.json", JSON.stringify(journal));
  } catch (error) {
    try { await recoverDevice(root); } catch { /* Unplug: persistent journal is recovered on next operation. */ }
    throw error;
  }
  // Failure cleaning up a committed journal must not report a completed transfer as failed.
  try { await recoverDevice(root); } catch { /* Retained committed journal is safe to clean after reconnect. */ }
}
