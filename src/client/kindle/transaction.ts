import { assertReachable, assertWindowsWritePath, directoryEntries, documentPath, EntryAccessError, entryName, entryOperation, optionalDirectory, optionalEntry, readInternalJson, writeBytes, type KindleDirectory, type KindleFile, type UnreadableEntry, type WriteProgress } from "./fs";
import { assertDevice, type PairedDevice } from "./identity";

const locks = new Map<string, Promise<unknown>>();
export async function withDeviceLock<T>(device: PairedDevice, action: () => Promise<T>, options: { readOnly?: boolean; onUnreadable?: (issue: UnreadableEntry) => void } = {}): Promise<T> {
  const id = device.identity.id, previous = locks.get(id) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const execute = async () => {
      const tolerate = (error: unknown) => { if (!options.readOnly || !(error instanceof EntryAccessError)) throw error; options.onUnreadable?.(error.issue); };
      try { await assertDevice(device); } catch (error) { tolerate(error); }
      try { await recoverDevice(device.root); } catch (error) { tolerate(error); }
      return action();
    };
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(`bindery-kindle-${id}`, execute);
    return execute();
  });
  locks.set(id, run);
  try { return await run; } finally { if (locks.get(id) === run) locks.delete(id); }
}
export interface DevicePatch { path: string[]; data: Uint8Array<ArrayBuffer> | string | Blob | null }
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
  for (let i = 0; i < path.length - 1; i++) {
    const current = dir, name = path[i], full = path.slice(0, i + 1).join("/");
    if (create) assertWindowsWritePath(full);
    dir = await entryOperation(root, full, () => current.getDirectoryHandle(name, { create }));
  }
  return { dir, name: path.at(-1)! };
}
async function remove(root: KindleDirectory, dir: KindleDirectory, name: string, prefix: string, recursive = false) {
  if (await optionalEntry(root, dir, name, prefix)) await entryOperation(root, `${prefix}/${name}`, () => dir.removeEntry(name, { recursive }));
}
async function copy(root: KindleDirectory, source: KindleDirectory | KindleFile, sourcePath: string, destination: KindleDirectory, name: string, destinationPath: string) {
  assertWindowsWritePath(destinationPath);
  if (source.kind === "file") {
    const bytes = await entryOperation(root, sourcePath, async () => new Uint8Array(await (await source.getFile()).arrayBuffer()));
    await entryOperation(root, destinationPath, () => writeBytes(destination, name, bytes)); return;
  }
  const dir = await entryOperation(root, destinationPath, () => destination.getDirectoryHandle(name, { create: true }));
  for (const entry of await directoryEntries(root, source, sourcePath)) await copy(root, entry, `${sourcePath}/${entry.name}`, dir, entry.name, `${destinationPath}/${entry.name}`);
}
type Snapshot = { kind: "file"; bytes: Uint8Array<ArrayBuffer> } | { kind: "directory"; children: { name: string; snapshot: Snapshot }[] };
async function snapshot(root: KindleDirectory, source: KindleDirectory | KindleFile, sourcePath: string, targetPath: string): Promise<Snapshot> {
  assertWindowsWritePath(targetPath);
  if (source.kind === "file") return { kind: "file", bytes: await entryOperation(root, sourcePath, async () => new Uint8Array(await (await source.getFile()).arrayBuffer())) };
  const children = [];
  for (const child of await directoryEntries(root, source, sourcePath)) children.push({ name: child.name, snapshot: await snapshot(root, child, `${sourcePath}/${child.name}`, `${targetPath}/${child.name}`) });
  return { kind: "directory", children };
}
async function restore(root: KindleDirectory, value: Snapshot, dir: KindleDirectory, name: string, path: string): Promise<void> {
  if (value.kind === "file") { await entryOperation(root, path, () => writeBytes(dir, name, value.bytes)); return; }
  const target = await entryOperation(root, path, () => dir.getDirectoryHandle(name, { create: true }));
  for (const child of value.children) await restore(root, child.snapshot, target, child.name, `${path}/${child.name}`);
}
/** Recover a prior interrupted mutation before any new write. Journal/backup remain on unplug. */
export async function recoverDevice(root: KindleDirectory) {
  await assertReachable(root);
  const internal = await optionalDirectory(root, ".bindery"); if (!internal) return;
  let journal: Journal | undefined;
  try { journal = await readInternalJson(root, "pending.json") as Journal | undefined; }
  catch (error) { if (error instanceof EntryAccessError || error instanceof Error && ["NotFoundError", "NotAllowedError"].includes(error.name)) throw error; throw new Error("设备恢复日志损坏，请保留 .bindery 并检查设备", { cause: error }); }
  if (journal === undefined) return;
  if (!journal || journal.version !== 1 || typeof journal.committed !== "boolean" || !Array.isArray(journal.backups)) throw new Error("设备恢复日志损坏");
  for (const b of journal.backups) { validatePath(b.path); if (![null, "file", "directory"].includes(b.kind)) throw new Error("设备恢复日志损坏"); }
  if (!journal.committed) {
    const backup = await entryOperation(root, ".bindery/rollback", () => internal.getDirectoryHandle("rollback"));
    // Read and validate every backup before touching destinations. A listed backup may be unreadable.
    const snapshots: (Snapshot | null)[] = [];
    for (let i = 0; i < journal.backups.length; i++) {
      const b = journal.backups[i];
      if (!b.kind) { snapshots.push(null); continue; }
      const source = await optionalEntry(root, backup, String(i), ".bindery/rollback");
      if (!source || source.kind !== b.kind) throw new Error("设备恢复备份不完整，请检查 .bindery/rollback");
      snapshots.push(await snapshot(root, source, `.bindery/rollback/${i}`, b.path.join("/")));
    }
    for (let i = journal.backups.length - 1; i >= 0; i--) {
      const b = journal.backups[i], target = await parent(root, b.path, true);
      if (b.kind !== "file") await remove(root, target.dir, target.name, b.path.slice(0, -1).join("/"), true);
      if (snapshots[i]) await restore(root, snapshots[i]!, target.dir, target.name, b.path.join("/"));
    }
    // Completed rollback is now cleanup-only, including if cleanup itself is interrupted.
    journal.committed = true;
    await entryOperation(root, ".bindery/pending.json", () => writeBytes(internal, "pending.json", JSON.stringify(journal)));
  }
  // Keep the cleanup-only journal until backups are gone so local cleanup failures can retry.
  await remove(root, internal, "rollback", ".bindery", true);
  await remove(root, internal, "pending.json", ".bindery");
}
/** Caller holds withDeviceLock. Backups + journal precede any target change; manifest is last. */
export async function applyDevicePatches(root: KindleDirectory, patches: DevicePatch[], signal?: AbortSignal, progress?: (patch: DevicePatch, progress: WriteProgress) => void) {
  const check = () => { if (signal?.aborted) throw new DOMException("操作已取消", "AbortError"); };
  check();
  for (const patch of patches) { validatePath(patch.path); if (patch.data !== null) assertWindowsWritePath(patch.path.join("/")); }
  if (new Set(patches.map(p => p.path.join("/").toLowerCase())).size !== patches.length) throw new Error("设备事务包含重复路径");
  const internal = await entryOperation(root, ".bindery", () => root.getDirectoryHandle(".bindery", { create: true }));
  await remove(root, internal, "rollback", ".bindery", true);
  const backup = await entryOperation(root, ".bindery/rollback", () => internal.getDirectoryHandle("rollback", { create: true })), journal: Journal = { version: 1, committed: false, backups: [] };
  for (let i = 0; i < patches.length; i++) {
    check(); const patch = patches[i], target = await parent(root, patch.path, true), current = await optionalEntry(root, target.dir, target.name, patch.path.slice(0, -1).join("/"));
    if (current?.kind === "directory" && patch.data !== null) throw new Error("目标文件名已被文件夹占用");
    if (current) await copy(root, current, patch.path.join("/"), backup, String(i), `.bindery/rollback/${i}`);
    journal.backups.push({ path: patch.path, kind: current?.kind ?? null });
  }
  await entryOperation(root, ".bindery/pending.json", () => writeBytes(internal, "pending.json", JSON.stringify(journal)));
  try {
    for (const patch of patches) {
      check(); const target = await parent(root, patch.path, true);
      if (patch.data === null) await remove(root, target.dir, target.name, patch.path.slice(0, -1).join("/"), true);
      else await entryOperation(root, patch.path.join("/"), () => writeBytes(target.dir, target.name, patch.data!, { signal, progress: value => progress?.(patch, value) }));
    }
    check(); journal.committed = true;
    await entryOperation(root, ".bindery/pending.json", () => writeBytes(internal, "pending.json", JSON.stringify(journal)));
  } catch (error) {
    try { await recoverDevice(root); } catch { /* Unplug: persistent journal is recovered on next operation. */ }
    throw error;
  }
  // Failure cleaning up a committed journal must not report a completed transfer as failed.
  try { await recoverDevice(root); } catch { /* Retained committed journal is safe to clean after reconnect. */ }
}
