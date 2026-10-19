import { getBokoConverter, type EpubConverter } from "../boko/client";
import { readKfxIdentity } from "../boko/kfx";
import { extractCover } from "../../core/epub";
import { appendProfileCss } from "./epub";
import { entryName, type KindleDirectory } from "./fs";
import { assertDevice } from "./identity";
import type { PairedDevice } from "./identity";
import { manifestBytes, readManifest, thumbnailName, type ManifestBook } from "./manifest";
import { defaultProfile, DEFAULT_PROFILE_ID, generateProfileCss, type TypesettingProfile } from "./profiles";
import { applyDevicePatches, withDeviceLock, type DevicePatch } from "./transaction";
import { makeThumbnail } from "./thumbnail";
import { listFonts } from "./fonts";

export type TransferState = "等待" | "转换" | "写入" | "完成" | "失败";
export interface TransferOptions { overwrite?: boolean; signal?: AbortSignal; progress?: (state: TransferState, message: string) => void }
export interface TransferDependencies {
  converter: EpubConverter;
  fetch: typeof fetch;
  profile: (deviceId: string, profileId: string) => Promise<TypesettingProfile>;
  thumbnail: (bytes: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
}
export function safeBookStem(title: string): string {
  let name = title.normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").trim().replace(/[. ]+$/g, "");
  // UTF-16 truncation without splitting a surrogate; leave room for suffixes and .kfx.
  name = Array.from(name).slice(0, 90).join("");
  while (new TextEncoder().encode(name).length > 180) name = Array.from(name).slice(0, -1).join("");
  if (!name || name === "." || name === "..") name = "book";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
export async function collisionSafeFilename(documents: KindleDirectory, title: string): Promise<string> {
  const occupied = new Set<string>(); for await (const entry of documents.values()) occupied.add(entry.name.toLowerCase());
  const stem = safeBookStem(title); let filename = `${stem}.kfx`, suffix = 2;
  while (occupied.has(filename.toLowerCase()) || occupied.has(filename.replace(/\.kfx$/i, ".sdr").toLowerCase())) filename = `${stem} (${suffix++}).kfx`;
  return filename;
}
async function loadProfile(deviceId: string, profileId: string) {
  if (profileId === DEFAULT_PROFILE_ID) return defaultProfile(deviceId);
  const { listKindleProfiles } = await import("../../server/kindle/functions");
  const profile = (await listKindleProfiles({ data: deviceId })).find(p => p.id === profileId);
  if (!profile) throw new Error("排版配置不存在或不属于此 Kindle"); return profile;
}
export class KindleTransferService {
  constructor(private dependencies: TransferDependencies) {}
  async transferBook(device: PairedDevice, bookId: string, profileId: string = DEFAULT_PROFILE_ID, options: TransferOptions = {}): Promise<ManifestBook> {
    if (!/^[a-f0-9]{32}$/.test(bookId)) throw new Error("无效的书库书籍 ID");
    const check = () => { if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError"); };
    check(); await assertDevice(device); options.progress?.("转换", "正在读取书库 EPUB");
    const profile = await this.dependencies.profile(device.identity.id, profileId);
    if (profile.deviceId !== device.identity.id || profile.id !== profileId) throw new Error("排版配置不属于此 Kindle");
    const css = generateProfileCss(profile);
    if (profile.id !== DEFAULT_PROFILE_ID && profile.settings.fontFamily && !(await listFonts(device.root)).some(f => f.name === profile.settings.fontFamily)) throw new Error(`Kindle 上未安装字体：${profile.settings.fontFamily}`);
    const response = await this.dependencies.fetch(`/book/${bookId}/download`, { credentials: "same-origin", redirect: "error", signal: options.signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "登录已过期，请重新登录" : `书库 EPUB 下载失败（${response.status}）`);
    const epub = new Uint8Array(await response.arrayBuffer()); check();
    const copy = appendProfileCss(epub, css);
    const result = await this.dependencies.converter.convert(copy, { signal: options.signal, progress: stage => options.progress?.("转换", ({ loading: "正在加载转换器", inspecting: "正在读取书籍信息", converting: "正在转换 KFX", metadata: "正在校验 KFX 元数据", done: "KFX 转换完成" })[stage]) });
    check();
    // Validate returned bytes at the I/O boundary too; callers may inject another converter.
    const identity = readKfxIdentity(result.data);
    const cover = extractCover(epub), thumbnail = cover ? await this.dependencies.thumbnail(cover[0]) : null;
    check();
    return withDeviceLock(device, async () => {
      check(); options.progress?.("写入", "正在写入 Kindle");
      const manifest = await readManifest(device.root), documents = await device.root.getDirectoryHandle("documents");
      const existing = options.overwrite ? manifest.books.find(b => b.book_id === bookId) : undefined;
      let filename = existing?.filename;
      // A recorded filename occupied by a directory is never overwritten.
      if (filename) { entryName(filename); try { await documents.getFileHandle(filename); } catch (error) { if (!(error instanceof Error && error.name === "NotFoundError")) throw error; } }
      filename ??= await collisionSafeFilename(documents, result.bookInfo.title || bookId);
      const thumb = thumbnail ? thumbnailName(identity.contentId, identity.cdeContentType) : null;
      const record: ManifestBook = { book_id: bookId, filename, content_id: identity.contentId, cde_content_type: identity.cdeContentType, profile_id: profile.id, profile_name: profile.name, transferred_at: new Date().toISOString(), size: result.data.length, thumbnail: thumb };
      const nextBooks = manifest.books.filter(b => b.filename.toLowerCase() !== filename!.toLowerCase());
      // Same EPUB ID may belong to several copies. Never overwrite a thumbnail we did not write.
      if (thumb) {
        const system = await device.root.getDirectoryHandle("system");
        let occupied = false;
        try { const dir = await system.getDirectoryHandle("thumbnails"); await dir.getFileHandle(thumb); occupied = true; }
        catch (error) { if (!(error instanceof Error && error.name === "NotFoundError")) throw error; await device.root.getDirectoryHandle("documents"); }
        if (occupied && !manifest.books.some(b => b.thumbnail === thumb)) throw new Error("设备已有同名封面缩略图，无法安全覆盖");
      }
      nextBooks.push(record);
      const patches: DevicePatch[] = [{ path: ["documents", filename], data: result.data }];
      if (thumbnail && thumb) patches.push({ path: ["system", "thumbnails", thumb], data: thumbnail });
      if (existing?.thumbnail && existing.thumbnail !== thumb && !nextBooks.some(b => b.thumbnail === existing.thumbnail)) patches.push({ path: ["system", "thumbnails", existing.thumbnail], data: null });
      patches.push({ path: [".bindery", "manifest.json"], data: manifestBytes({ version: 1, books: nextBooks }) });
      await applyDevicePatches(device.root, patches, options.signal);
      options.progress?.("完成", "已传入 Kindle");
      return record;
    });
  }
}
let shared: KindleTransferService | undefined;
export const getTransferService = () => shared ??= new KindleTransferService({ converter: getBokoConverter(), fetch: (...args) => fetch(...args), profile: loadProfile, thumbnail: makeThumbnail });
export const transferBook = (device: PairedDevice, bookId: string, profileId = DEFAULT_PROFILE_ID, options?: TransferOptions) => getTransferService().transferBook(device, bookId, profileId, options);
