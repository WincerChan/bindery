import { getBokoConverter, type EpubConverter } from "../boko/client";
import { ConversionEstimate } from "../boko/estimate";
import { readKfxIdentity } from "../boko/kfx";
import { extractCover, extractEpubMetadata } from "../../core/epub";
import { bookFingerprint } from "../../core/fingerprint";
import { applyTypesettingProfile } from "../../core/epub-profile-css";
import { assertWindowsWritePath, directoryEntries, entryName, entryOperation, optionalDirectory, optionalEntry, type KindleDirectory } from "./fs";
import { assertDevice } from "../devices/identity";
import type { PairedDevice } from "../devices/identity";
import type { TransferOptions as DeviceTransferOptions } from "../devices/queue";
import { manifestBytes, readManifest, thumbnailName, type ManifestBook } from "./manifest";
import { kindleRecordFingerprint } from "./record-fingerprint";
import { defaultProfile, DEFAULT_PROFILE_ID, profileSettings, resolveTransferProfile, type TypesettingProfile } from "../devices/profiles";
import { applyDevicePatchesFor, withDeviceLock, type DevicePatch } from "./transaction";
import { makeThumbnail } from "./thumbnail";
import { listFonts } from "./fonts";
import { PROGRESS_INTERVAL_MS, TransferProgressReporter, type TransferProgress } from "./progress";

export type { TransferState, TransferPhase, TransferProgress } from "./progress";
export interface TransferOptions extends DeviceTransferOptions {}
export interface TransferDependencies {
  converter: EpubConverter;
  fetch: typeof fetch;
  profile: (profileId: string) => Promise<TypesettingProfile>;
  thumbnail: (bytes: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
}
import { BOOK_STEM_BUDGET, fitStem, safeBookStem } from "../devices/paths";
export { BOOK_STEM_BUDGET, fitStem, safeBookStem };
export function assertBookFilename(filename: string) {
  const stem = filename.replace(/\.kfx$/i, "");
  assertWindowsWritePath(`documents/${filename}`);
  assertWindowsWritePath(`documents/${stem}.sdr/${stem}${"0".repeat(32)}.yjr.bad_file`);
}
export async function collisionSafeFilename(documents: KindleDirectory, title: string, root: KindleDirectory): Promise<string> {
  const occupied = new Set<string>();
  const entries = await directoryEntries(root, documents, "documents");
  for (const entry of entries) occupied.add(entry.name.toLowerCase());
  const stem = safeBookStem(title); let filename = `${stem}.kfx`, suffix = 2;
  while (occupied.has(filename.toLowerCase()) || occupied.has(filename.replace(/\.kfx$/i, ".sdr").toLowerCase())) {
    const ending = ` (${suffix++})`;
    filename = `${fitStem(stem, BOOK_STEM_BUDGET - ending.length)}${ending}.kfx`;
  }
  return filename;
}
async function loadProfile(profileId: string) {
  if (profileId === DEFAULT_PROFILE_ID) return defaultProfile();
  const { listTypesetProfiles } = await import("../../server/typeset/functions");
  const profile = (await listTypesetProfiles()).find(p => p.id === profileId);
  if (!profile) throw new Error("排版方案不存在"); return profile;
}
/** A shared fingerprint among device records is ambiguous, so no old copy is overwritten. */
async function overwriteTarget(root: KindleDirectory, books: ManifestBook[], bookId: string, fingerprint: string | null): Promise<ManifestBook | undefined> {
  const byId = books.find(book => book.book_id === bookId);
  if (byId || !fingerprint) return byId;
  const matches: ManifestBook[] = [];
  for (const book of books) {
    const value = book.fingerprint ?? await kindleRecordFingerprint(root, book);
    if (value === fingerprint) matches.push(book);
  }
  return matches.length === 1 ? matches[0] : undefined;
}
export class KindleTransferService {
  private conversionEstimate = new ConversionEstimate();
  constructor(private dependencies: TransferDependencies) {}
  async transferBook(device: PairedDevice, bookId: string, profileId: string = DEFAULT_PROFILE_ID, options: TransferOptions = {}): Promise<ManifestBook> {
    if (!/^[a-f0-9]{32}$/.test(bookId)) throw new Error("无效的书库书籍 ID");
    const check = () => { if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError"); };
    const progress = new TransferProgressReporter(options.progress);
    check(); await assertDevice(device); progress.report({ state: "转换", phase: "download", message: "正在读取书库 EPUB" });
    const profileLoaded = await resolveTransferProfile(profileId, options.settings, this.dependencies.profile);
    const profile = { ...profileLoaded, settings: profileSettings(profileLoaded.settings) };
    if (profile.settings.fontFamily && !(await listFonts(device.root)).some(f => f.name === profile.settings.fontFamily)) throw new Error(`Kindle 上未安装字体：${profile.settings.fontFamily}`);
    const response = await this.dependencies.fetch(`/book/${bookId}/download`, { credentials: "same-origin", redirect: "error", signal: options.signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "登录已过期，请重新登录" : `书库 EPUB 下载失败（${response.status}）`);
    if (!response.body) throw new Error("书库 EPUB 下载响应没有数据流");
    const length = Number(response.headers.get("Content-Length"));
    let total = Number.isSafeInteger(length) && length > 0 ? length : undefined, loaded = 0;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    const downloadProgress = (flush = false) => progress.report({ state: "转换", phase: "download", message: "正在下载 EPUB", loaded, total }, flush);
    // Cancel pending reads as well as fetch. This also handles injected/local streams.
    const cancelRead = () => { void reader.cancel().catch(() => {}); };
    options.signal?.addEventListener("abort", cancelRead, { once: true });
    try {
      check(); downloadProgress(true);
      while (true) {
        check(); const chunk = await reader.read(); check();
        if (chunk.done) break;
        chunks.push(chunk.value); loaded += chunk.value.byteLength;
        // A decoded response may exceed its encoded Content-Length.
        if (total !== undefined && loaded > total) total = undefined;
        downloadProgress();
      }
      downloadProgress(true);
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { options.signal?.removeEventListener("abort", cancelRead); reader.releaseLock(); }
    const epub = new Uint8Array(loaded);
    let offset = 0; for (const chunk of chunks) { epub.set(chunk, offset); offset += chunk.byteLength; }
    chunks.length = 0;
    check();
    const metadata = extractEpubMetadata(epub, bookId), fingerprint = await bookFingerprint(metadata.title, metadata.author);
    const copy = applyTypesettingProfile(epub, profile);
    const conversionStartedAt = Date.now(), estimateMs = this.conversionEstimate.durationMs(copy.byteLength);
    let conversionMessage = "正在转换 KFX", measuredStart = conversionStartedAt, measuredEnd: number | undefined;
    const reportConversion = () => {
      const elapsedMs = Date.now() - conversionStartedAt, etaSeconds = Math.max(0, (estimateMs - elapsedMs) / 1000);
      const estimate = etaSeconds > 0 ? `预计剩余约 ${Math.max(1, Math.ceil(etaSeconds))} 秒（估计）` : "已超出估计时间，仍在处理";
      progress.report({ state: "转换", phase: "convert", message: `${conversionMessage} · 已用 ${(elapsedMs / 1000).toFixed(1)} 秒 · ${estimate}`, etaSeconds });
    };
    reportConversion();
    const timer = options.progress ? setInterval(reportConversion, PROGRESS_INTERVAL_MS) : undefined;
    let result;
    try {
      result = await this.dependencies.converter.convert(copy, { signal: options.signal, progress: stage => {
        if (stage === "converting") measuredStart = Date.now();
        if (stage === "metadata" && measuredEnd === undefined) measuredEnd = Date.now();
        conversionMessage = ({ loading: "正在加载转换器", inspecting: "正在读取书籍信息", converting: "正在转换 KFX", metadata: "正在校验 KFX 元数据", done: "KFX 转换完成" })[stage];
        reportConversion();
      } });
      check(); this.conversionEstimate.record(copy.byteLength, (measuredEnd ?? Date.now()) - measuredStart);
    } finally { if (timer !== undefined) clearInterval(timer); }
    check();
    // Validate returned bytes at the I/O boundary too; callers may inject another converter.
    const identity = readKfxIdentity(result.data);
    const cover = extractCover(epub);
    if (cover) progress.report({ state: "转换", phase: "thumbnail", message: "正在生成封面缩略图" });
    const thumbnail = cover ? await this.dependencies.thumbnail(cover[0]) : null;
    check();
    return withDeviceLock(device, async () => {
      check(); progress.report({ state: "写入", phase: "write", message: "正在准备 Kindle 写入与恢复备份", loaded: 0, total: result.data.byteLength });
      const manifest = await readManifest(device.root), documents = await entryOperation(device.root, "documents", () => device.root.getDirectoryHandle("documents"));
      const existing = options.overwrite ? await overwriteTarget(device.root, manifest.books, bookId, fingerprint) : undefined;
      let filename = existing?.filename;
      // A recorded filename occupied by a directory is never overwritten.
      if (filename) {
        entryName(filename); assertBookFilename(filename);
        const occupied = await optionalEntry(device.root, documents, filename, "documents");
        if (occupied?.kind === "directory") throw new Error("目标文件名已被文件夹占用");
      }
      filename ??= await collisionSafeFilename(documents, result.bookInfo.title || bookId, device.root);
      assertBookFilename(filename);
      const thumb = thumbnail ? thumbnailName(identity.contentId, identity.cdeContentType) : null;
      const record: ManifestBook = { book_id: bookId, filename, content_id: identity.contentId, cde_content_type: identity.cdeContentType, profile_id: profile.id, profile_name: profile.name, transferred_at: new Date().toISOString(), size: result.data.length, thumbnail: thumb, ...(fingerprint ? { fingerprint } : {}) };
      const nextBooks = manifest.books.filter(b => b.filename.toLowerCase() !== filename!.toLowerCase());
      // Same EPUB ID may belong to several copies. Never overwrite a thumbnail we did not write.
      if (thumb) {
        const system = await entryOperation(device.root, "system", () => device.root.getDirectoryHandle("system"));
        const dir = await optionalDirectory(system, "thumbnails", device.root, "system");
        const occupied = dir && await optionalEntry(device.root, dir, thumb, "system/thumbnails");
        if (occupied && !manifest.books.some(b => b.thumbnail === thumb)) throw new Error("设备已有同名封面缩略图，无法安全覆盖");
      }
      nextBooks.push(record);
      const patches: DevicePatch[] = [{ path: ["documents", filename], data: result.data }];
      if (thumbnail && thumb) patches.push({ path: ["system", "thumbnails", thumb], data: thumbnail });
      if (existing?.thumbnail && existing.thumbnail !== thumb && !nextBooks.some(b => b.thumbnail === existing.thumbnail)) patches.push({ path: ["system", "thumbnails", existing.thumbnail], data: null });
      patches.push({ path: [".bindery", "manifest.json"], data: manifestBytes({ version: 1, books: nextBooks }) });
      await applyDevicePatchesFor(device.root, "kindle", patches, options.signal, (patch, value) => {
        if (patch === patches[0]) {
          progress.report({ state: "写入", phase: value.committing ? "finalize" : "write", message: value.committing ? "正在完成写入" : "正在写入 Kindle", loaded: value.loaded, total: value.total }, value.committing || value.loaded === value.total);
        } else {
          progress.report({ state: "写入", phase: "finalize", message: "正在保存封面与传输记录" });
        }
      });
      progress.report({ state: "完成", phase: "finalize", message: "已传入 Kindle" });
      return record;
    });
  }
}
let shared: KindleTransferService | undefined;
export const getTransferService = () => shared ??= new KindleTransferService({ converter: getBokoConverter(), fetch: (...args) => fetch(...args), profile: loadProfile, thumbnail: makeThumbnail });
export const transferBook = (device: PairedDevice, bookId: string, profileId = DEFAULT_PROFILE_ID, options?: TransferOptions) => getTransferService().transferBook(device, bookId, profileId, options);
