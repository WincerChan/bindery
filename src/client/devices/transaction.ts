import { assertReachable, assertWindowsWritePath, directoryEntries, documentPath, EntryAccessError, entryName, entryOperation, optionalDirectory, optionalEntry, readInternalJson, writeBytes, type DeviceDirectory, type DeviceFile, type UnreadableEntry, type WriteProgress } from "./fs";
import { assertDevice, type PairedDevice } from "./identity";
import type { DeviceKind } from "./models";

const locks = new Map<string, Promise<unknown>>();
export async function withDeviceLock<T>(device: PairedDevice, action: () => Promise<T>, options: { readOnly?: boolean; onUnreadable?: (issue: UnreadableEntry) => void } = {}): Promise<T> {
  const id = device.identity.id, kind = device.identity.kind, previous = locks.get(id) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const execute = async () => {
      const tolerate = (error: unknown) => { if (!options.readOnly || !(error instanceof EntryAccessError)) throw error; options.onUnreadable?.(error.issue); };
      try { await assertDevice(device); } catch (error) { tolerate(error); }
      try { await recoverDevice(device.root, kind); } catch (error) { tolerate(error); }
      return action();
    };
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(`bindery-device-${id}`, execute);
    return execute();
  });
  locks.set(id, run);
  try { return await run; } finally { if (locks.get(id) === run) locks.delete(id); }
}
export interface DevicePatch { path: string[]; data: Uint8Array<ArrayBuffer> | string | Blob | null }
interface Backup { path: string[]; kind: "file" | "directory" | null }
interface Journal { version: 1; committed: boolean; backups: Backup[] }

const kindleLabel = (kind: DeviceKind) => kind === "kindle" ? "Kindle" : "Kobo";
export function validateDevicePath(path: unknown, kind: DeviceKind = "kindle"): asserts path is string[] {
  if (!Array.isArray(path) || !path.every(p => typeof p === "string" && entryName(p) === p)) throw new Error("无效的设备事务路径");
  const [dir, name] = path;
  if (kind === "kobo") {
    const managedBook = path.length >= 2 && dir === "Bindery" && path.slice(1).every(part => !part.startsWith("._")) && /\.kepub\.epub$/i.test(path.at(-1)!);
    const font = path.length === 2 && dir === "fonts" && /\.(ttf|otf)$/i.test(name) && !name.startsWith("._");
    const identity = path.length === 2 && dir === ".bindery" && name === "device.json";
    if (!managedBook && !font && !identity) throw new Error("拒绝访问 Kobo 受保护路径");
    return;
  }
  const documents = dir === "documents" && path.length >= 2 && documentPath(path.slice(1).join("/")).length === path.length - 1 && /\.(kfx|azw|azw3|txt|sdr)$/i.test(path.at(-1)!);
  const allowed = documents || path.length === 2 && (dir === "fonts" && /\.(ttf|otf)$/i.test(name) && !name.startsWith("._") || dir === ".bindery" && name === "manifest.json") || path.length === 3 && dir === "system" && name === "thumbnails" && /^thumbnail_[\w-]+_(EBOK|PDOC)_portrait\.jpg$/.test(path[2]);
  if (!allowed) throw new Error(`拒绝访问 ${kindleLabel(kind)} 受保护路径`);
}
async function parent(root: DeviceDirectory, path: string[], create = false, kind: DeviceKind = "kindle") {
  let dir = root;
  for (let i = 0; i < path.length - 1; i++) {
    const current = dir, name = path[i], full = path.slice(0, i + 1).join("/");
    if (create) assertWindowsWritePath(full);
    dir = await entryOperation(root, full, () => current.getDirectoryHandle(name, { create }), kind);
  }
  return { dir, name: path.at(-1)! };
}
async function remove(root: DeviceDirectory, dir: DeviceDirectory, name: string, prefix: string, recursive = false, kind: DeviceKind = "kindle") {
  if (await optionalEntry(root, dir, name, prefix, kind)) await entryOperation(root, `${prefix}/${name}`, () => dir.removeEntry(name, { recursive }), kind);
}
async function copy(root: DeviceDirectory, source: DeviceDirectory | DeviceFile, sourcePath: string, destination: DeviceDirectory, name: string, destinationPath: string, kind: DeviceKind) {
  assertWindowsWritePath(destinationPath);
  if (source.kind === "file") {
    const bytes = await entryOperation(root, sourcePath, async () => new Uint8Array(await (await source.getFile()).arrayBuffer()), kind);
    await entryOperation(root, destinationPath, () => writeBytes(destination, name, bytes), kind); return;
  }
  const dir = await entryOperation(root, destinationPath, () => destination.getDirectoryHandle(name, { create: true }), kind);
  for (const entry of await directoryEntries(root, source, sourcePath, kind)) await copy(root, entry, `${sourcePath}/${entry.name}`, dir, entry.name, `${destinationPath}/${entry.name}`, kind);
}
type Snapshot = { kind: "file"; bytes: Uint8Array<ArrayBuffer> } | { kind: "directory"; children: { name: string; snapshot: Snapshot }[] };
async function snapshot(root: DeviceDirectory, source: DeviceDirectory | DeviceFile, sourcePath: string, targetPath: string, kind: DeviceKind): Promise<Snapshot> {
  assertWindowsWritePath(targetPath);
  if (source.kind === "file") return { kind: "file", bytes: await entryOperation(root, sourcePath, async () => new Uint8Array(await (await source.getFile()).arrayBuffer()), kind) };
  const children = [];
  for (const child of await directoryEntries(root, source, sourcePath, kind)) children.push({ name: child.name, snapshot: await snapshot(root, child, `${sourcePath}/${child.name}`, `${targetPath}/${child.name}`, kind) });
  return { kind: "directory", children };
}
async function restore(root: DeviceDirectory, value: Snapshot, dir: DeviceDirectory, name: string, path: string, kind: DeviceKind): Promise<void> {
  if (value.kind === "file") { await entryOperation(root, path, () => writeBytes(dir, name, value.bytes), kind); return; }
  const target = await entryOperation(root, path, () => dir.getDirectoryHandle(name, { create: true }), kind);
  for (const child of value.children) await restore(root, child.snapshot, target, child.name, `${path}/${child.name}`, kind);
}
/** Recover a prior interrupted mutation before any new write. Journal/backup remain on unplug. */
export async function recoverDevice(root: DeviceDirectory, kind: DeviceKind = "kindle") {
  await assertReachable(root, kind);
  const internal = await optionalDirectory(root, ".bindery", root, "", kind); if (!internal) return;
  let journal: Journal | undefined;
  try { journal = await readInternalJson(root, "pending.json", kind) as Journal | undefined; }
  catch (error) { if (error instanceof EntryAccessError || error instanceof Error && ["NotFoundError", "NotAllowedError"].includes(error.name)) throw error; throw new Error("设备恢复日志损坏，请保留 .bindery 并检查设备", { cause: error }); }
  if (journal === undefined) return;
  if (!journal || journal.version !== 1 || typeof journal.committed !== "boolean" || !Array.isArray(journal.backups)) throw new Error("设备恢复日志损坏");
  for (const b of journal.backups) { validateDevicePath(b.path, kind); if (![null, "file", "directory"].includes(b.kind)) throw new Error("设备恢复日志损坏"); }
  if (!journal.committed) {
    const backup = await entryOperation(root, ".bindery/rollback", () => internal.getDirectoryHandle("rollback"), kind);
    // Read and validate every backup before touching destinations. A listed backup may be unreadable.
    const snapshots: (Snapshot | null)[] = [];
    for (let i = 0; i < journal.backups.length; i++) {
      const b = journal.backups[i];
      if (!b.kind) { snapshots.push(null); continue; }
      const source = await optionalEntry(root, backup, String(i), ".bindery/rollback", kind);
      if (!source || source.kind !== b.kind) throw new Error("设备恢复备份不完整，请检查 .bindery/rollback");
      snapshots.push(await snapshot(root, source, `.bindery/rollback/${i}`, b.path.join("/"), kind));
    }
    for (let i = journal.backups.length - 1; i >= 0; i--) {
      const b = journal.backups[i], target = await parent(root, b.path, true, kind);
      if (b.kind !== "file") await remove(root, target.dir, target.name, b.path.slice(0, -1).join("/"), true, kind);
      if (snapshots[i]) await restore(root, snapshots[i]!, target.dir, target.name, b.path.join("/"), kind);
    }
    // Completed rollback is now cleanup-only, including if cleanup itself is interrupted.
    journal.committed = true;
    await entryOperation(root, ".bindery/pending.json", () => writeBytes(internal, "pending.json", JSON.stringify(journal)), kind);
  }
  // Keep the cleanup-only journal until backups are gone so local cleanup failures can retry.
  await remove(root, internal, "rollback", ".bindery", true, kind);
  await remove(root, internal, "pending.json", ".bindery", false, kind);
}
/** Caller holds withDeviceLock. Backups + journal precede any target change; manifest is last. */
export async function applyDevicePatchesFor(root: DeviceDirectory, kind: DeviceKind, patches: DevicePatch[], signal?: AbortSignal, progress?: (patch: DevicePatch, progress: WriteProgress) => void) {
  const check = () => { if (signal?.aborted) throw new DOMException("操作已取消", "AbortError"); };
  check();
  for (const patch of patches) { validateDevicePath(patch.path, kind); if (patch.data !== null) assertWindowsWritePath(patch.path.join("/")); }
  if (new Set(patches.map(p => p.path.join("/").toLowerCase())).size !== patches.length) throw new Error("设备事务包含重复路径");
  const internal = await entryOperation(root, ".bindery", () => root.getDirectoryHandle(".bindery", { create: true }), kind);
  await remove(root, internal, "rollback", ".bindery", true, kind);
  const backup = await entryOperation(root, ".bindery/rollback", () => internal.getDirectoryHandle("rollback", { create: true }), kind), journal: Journal = { version: 1, committed: false, backups: [] };
  for (let i = 0; i < patches.length; i++) {
    check(); const patch = patches[i], target = await parent(root, patch.path, true, kind), current = await optionalEntry(root, target.dir, target.name, patch.path.slice(0, -1).join("/"), kind);
    if (current?.kind === "directory" && patch.data !== null) throw new Error("目标文件名已被文件夹占用");
    if (current) await copy(root, current, patch.path.join("/"), backup, String(i), `.bindery/rollback/${i}`, kind);
    journal.backups.push({ path: patch.path, kind: current?.kind ?? null });
  }
  await entryOperation(root, ".bindery/pending.json", () => writeBytes(internal, "pending.json", JSON.stringify(journal)), kind);
  try {
    for (const patch of patches) {
      check(); const target = await parent(root, patch.path, true, kind);
      if (patch.data === null) await remove(root, target.dir, target.name, patch.path.slice(0, -1).join("/"), true, kind);
      else await entryOperation(root, patch.path.join("/"), () => writeBytes(target.dir, target.name, patch.data!, { signal, progress: value => progress?.(patch, value) }), kind);
    }
    check(); journal.committed = true;
    await entryOperation(root, ".bindery/pending.json", () => writeBytes(internal, "pending.json", JSON.stringify(journal)), kind);
  } catch (error) {
    try { await recoverDevice(root, kind); } catch { /* Unplug: persistent journal is recovered on next operation. */ }
    throw error;
  }
  // Failure cleaning up a committed journal must not report a completed transfer as failed.
  try { await recoverDevice(root, kind); } catch { /* Retained committed journal is safe to clean after reconnect. */ }
}
/** Kindle-compatible entry point retained for existing callers and tests. */
export function applyDevicePatches(root: DeviceDirectory, patches: DevicePatch[], signal?: AbortSignal, progress?: (patch: DevicePatch, progress: WriteProgress) => void) {
  return applyDevicePatchesFor(root, "kindle", patches, signal, progress);
}
