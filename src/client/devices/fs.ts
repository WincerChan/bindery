import type { DeviceKind } from "./models";

/** Structural subset of Chrome's File System Access API (also used by the Node fake). */
export interface DeviceFile {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob | Uint8Array<ArrayBuffer> | string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
export interface DeviceDirectory {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DeviceDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<DeviceFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterableIterator<DeviceDirectory | DeviceFile>;
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
}
export type KindleDirectory = DeviceDirectory;
export type KindleFile = DeviceFile;
export const isMissing = (error: unknown) => error instanceof Error && error.name === "NotFoundError";
export const isEntryFailure = (error: unknown) => error instanceof Error && ["NotFoundError", "NotReadableError", "InvalidStateError", "NotAllowedError", "SecurityError"].includes(error.name);
export interface UnreadableEntry { path: string; reason: string; likelyCause: string; windowsPathLength: number }
export const windowsPath = (path: string) => `X:\\${path.replaceAll("/", "\\")}`;
export function entryIssue(path: string, error: unknown): UnreadableEntry {
  const windowsPathLength = windowsPath(path).length;
  const invalid = path.split("/").some(p => /[<>:"\\|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
  return { path, reason: error instanceof Error ? error.name : "Error", windowsPathLength, likelyCause: windowsPathLength >= 260 ? "路径达到或超过 Windows 260 字符限制" : invalid ? "Windows 不支持的文件名" : "文件不可读或访问受限" };
}
export class EntryAccessError extends Error {
  readonly issue: UnreadableEntry;
  constructor(path: string, cause: unknown) {
    const issue = entryIssue(path, cause);
    super(`无法访问 ${path}（${issue.reason}；${issue.likelyCause}）`, { cause });
    this.name = "EntryAccessError"; this.issue = issue;
  }
}
const deviceLabel = (kind: DeviceKind) => kind === "kindle" ? "Kindle" : "Kobo";
class DeviceDisconnectedError extends Error {
  constructor(cause: unknown, kind: DeviceKind = "kindle") { super(`${deviceLabel(kind)} 已断开，请重新插入后重试`, { cause }); this.name = "NotFoundError"; }
}
/** Only a failed root sentinel establishes device loss. Preserve permission errors. */
export async function assertReachable(root: DeviceDirectory, kind: DeviceKind = "kindle") {
  try { await root.getDirectoryHandle(kind === "kobo" ? ".kobo" : "documents"); }
  catch (error) {
    if (error instanceof Error && ["NotAllowedError", "SecurityError"].includes(error.name)) throw error;
    throw new DeviceDisconnectedError(error, kind);
  }
}
export async function entryOperation<T>(root: DeviceDirectory, path: string, action: () => Promise<T>, kind: DeviceKind = "kindle"): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (!isEntryFailure(error)) throw error;
    await assertReachable(root, kind);
    throw new EntryAccessError(path, error);
  }
}
export const directoryEntries = (root: DeviceDirectory, dir: DeviceDirectory, path: string, kind: DeviceKind = "kindle") => entryOperation(root, path, async () => {
  const entries: (DeviceDirectory | DeviceFile)[] = [];
  for await (const entry of dir.values()) entries.push(entry);
  return entries;
}, kind);
/** Enumerate first: a listed entry's NotFoundError is not evidence of absence. */
export async function optionalEntry(root: DeviceDirectory, dir: DeviceDirectory, name: string, path: string, kind: DeviceKind = "kindle") {
  return (await directoryEntries(root, dir, path, kind)).find(e => e.name.toLowerCase() === name.toLowerCase()) ?? null;
}
export function assertWindowsWritePath(path: string) {
  if (windowsPath(path).length >= 260 || entryIssue(path, null).likelyCause === "Windows 不支持的文件名") throw new Error(`文件路径不适用于 Windows：${path}`);
}
export class EntryReader {
  private issues = new Map<string, UnreadableEntry>();
  constructor(readonly root: DeviceDirectory, issues: UnreadableEntry[] = [], readonly kind: DeviceKind = "kindle") { for (const issue of issues) this.issues.set(issue.path, issue); }
  get unreadable() { return [...this.issues.values()]; }
  async read<T>(path: string, action: () => Promise<T>): Promise<T | null> {
    if (this.issues.has(path)) return null;
    try { return await entryOperation(this.root, path, action, this.kind); }
    catch (error) { if (!(error instanceof EntryAccessError)) throw error; this.issues.set(error.issue.path, error.issue); return null; }
  }
}
export const protectedEntry = (name: string) => name.startsWith("._") || [".Trashes", ".Spotlight-V100", "System Volume Information", ".Trash-1000", ".active_content_sandbox", "metadata.calibre", "driveinfo.calibre"].some(v => v.toLowerCase() === name.toLowerCase());
/** Relative documents path only: no Windows separators, traversal or OS/calibre entries. */
export function documentPath(path: string): string[] {
  const parts = path.split("/");
  if (!parts.every(part => entryName(part) === part && !protectedEntry(part))) throw new Error("拒绝访问 Kindle 受保护路径");
  return parts;
}
export function entryName(name: string): string {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw new Error("非法文件名");
  return name;
}
export async function optionalDirectory(dir: DeviceDirectory, name: string, root = dir, prefix = "", kind: DeviceKind = "kindle") {
  const entry = await optionalEntry(root, dir, entryName(name), prefix, kind);
  if (!entry) return null;
  if (entry.kind !== "directory") throw new Error(`预期文件夹：${prefix}/${name}`);
  return entry;
}
export async function readBytes(root: DeviceDirectory, name: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await (await (await root.getFileHandle(entryName(name))).getFile()).arrayBuffer());
}
export async function readJson(root: DeviceDirectory, name: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBytes(root, name)));
}
export async function readInternalJson(root: DeviceDirectory, name: string, kind: DeviceKind = "kindle"): Promise<unknown> {
  await assertReachable(root, kind);
  const internal = await optionalDirectory(root, ".bindery", root, "", kind);
  if (!internal || !await optionalEntry(root, internal, name, ".bindery", kind)) return undefined;
  return entryOperation(root, `.bindery/${name}`, () => readJson(internal, name), kind);
}
export interface WriteProgress { loaded: number; total: number; committing: boolean }
export interface WriteOptions { signal?: AbortSignal; progress?: (progress: WriteProgress) => void }
export const WRITE_CHUNK_SIZE = 1024 * 1024;
export async function writeBytes(root: DeviceDirectory, name: string, data: Uint8Array<ArrayBuffer> | string | Blob, options: WriteOptions = {}) {
  const check = () => { if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError"); };
  check();
  const writable = await (await root.getFileHandle(entryName(name), { create: true })).createWritable();
  try {
    check();
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const total = bytes instanceof Blob ? bytes.size : bytes.byteLength;
    options.progress?.({ loaded: 0, total, committing: false });
    for (let offset = 0; offset < total; offset += WRITE_CHUNK_SIZE) {
      check();
      const end = Math.min(total, offset + WRITE_CHUNK_SIZE);
      await writable.write(bytes instanceof Blob ? bytes.slice(offset, end) : bytes.subarray(offset, end));
      check(); options.progress?.({ loaded: end, total, committing: false });
    }
    check(); options.progress?.({ loaded: total, total, committing: true }); check();
    // Chrome commits its .crswap file here. Accepted chunks alone are not a committed file.
    await writable.close(); check();
  }
  catch (error) { try { await writable.abort(); } catch { /* Original error carries disconnect/permission information. */ } throw error; }
}
export function errorMessage(error: unknown, kind: DeviceKind = "kindle"): string {
  if (error instanceof Error) {
    if (error instanceof DeviceDisconnectedError) return error.message;
    if (error.name === "NotFoundError") return "文件或目录无法访问，请重新检测设备";
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return `没有 ${deviceLabel(kind)} 读写权限，请点击授权后重试`;
    if (error.name === "AbortError") return "操作已取消";
    if (error.name === "QuotaExceededError") return `${deviceLabel(kind)} 空间不足`;
    return error.message;
  }
  return `${deviceLabel(kind)} 操作失败`;
}
