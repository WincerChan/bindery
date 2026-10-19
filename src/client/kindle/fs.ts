/** Structural subset of Chrome's File System Access API (also used by the Node fake). */
export interface KindleFile {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob | Uint8Array<ArrayBuffer> | string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
export interface KindleDirectory {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<KindleDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<KindleFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterableIterator<KindleDirectory | KindleFile>;
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
}
export const isMissing = (error: unknown) => error instanceof Error && error.name === "NotFoundError";
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
export async function optionalDirectory(root: KindleDirectory, name: string) {
  try { return await root.getDirectoryHandle(entryName(name)); } catch (error) { if (isMissing(error)) return null; throw error; }
}
export async function readBytes(root: KindleDirectory, name: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await (await (await root.getFileHandle(entryName(name))).getFile()).arrayBuffer());
}
export async function readJson(root: KindleDirectory, name: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBytes(root, name)));
}
export async function writeBytes(root: KindleDirectory, name: string, data: Uint8Array<ArrayBuffer> | string | Blob) {
  const writable = await (await root.getFileHandle(entryName(name), { create: true })).createWritable();
  try { await writable.write(data); await writable.close(); }
  catch (error) { try { await writable.abort(); } catch { /* Original error carries disconnect/permission information. */ } throw error; }
}
export async function removeIfPresent(root: KindleDirectory, name: string, recursive = false) {
  try { await root.removeEntry(entryName(name), { recursive }); } catch (error) { if (!isMissing(error)) throw error; }
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotFoundError") return "Kindle 已断开，请重新插入后重试";
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "没有 Kindle 读写权限，请点击授权后重试";
    if (error.name === "AbortError") return "操作已取消";
    if (error.name === "QuotaExceededError") return "Kindle 空间不足";
    return error.message;
  }
  return "Kindle 操作失败";
}
