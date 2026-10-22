import { extractEpubMetadata } from "../../../core/epub";
import { assertDevice, type PairedDevice } from "../identity";
import { assertDeviceBookPath, koboBookFilename } from "../paths";
import { PROGRESS_INTERVAL_MS, TransferProgressReporter } from "../progress";
import type { TransferOptions, TransferResult, TransferService } from "../queue";
import { applyDevicePatchesFor, withDeviceLock } from "../transaction";
import { getKepubConverter, type KepubConverter } from "./kepub-client";

export interface KoboTransferDependencies {
  converter: KepubConverter;
  fetch: typeof fetch;
}
export class KoboTransferService implements TransferService {
  constructor(private dependencies: KoboTransferDependencies) {}
  async transferBook(device: PairedDevice, bookId: string, _profileId: string = "default", options: TransferOptions = {}): Promise<TransferResult> {
    if (device.identity.kind !== "kobo") throw new Error("Kobo 传书服务收到了非 Kobo 设备");
    if (!/^[a-f0-9]{32}$/.test(bookId)) throw new Error("无效的书库书籍 ID");
    const check = () => { if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError"); };
    const progress = new TransferProgressReporter(options.progress);
    check(); await assertDevice(device);
    progress.report({ state: "转换", phase: "download", message: "正在读取书库 EPUB" });
    const response = await this.dependencies.fetch(`/book/${bookId}/download`, { credentials: "same-origin", redirect: "error", signal: options.signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "登录已过期，请重新登录" : `书库 EPUB 下载失败（${response.status}）`);
    if (!response.body) throw new Error("书库 EPUB 下载响应没有数据流");
    const length = Number(response.headers.get("Content-Length"));
    let total = Number.isSafeInteger(length) && length > 0 ? length : undefined, loaded = 0;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    const downloadProgress = (flush = false) => progress.report({ state: "转换", phase: "download", message: "正在下载 EPUB", loaded, total }, flush);
    const cancelRead = () => { void reader.cancel().catch(() => {}); };
    options.signal?.addEventListener("abort", cancelRead, { once: true });
    try {
      check(); downloadProgress(true);
      while (true) {
        check(); const chunk = await reader.read(); check();
        if (chunk.done) break;
        chunks.push(chunk.value); loaded += chunk.value.byteLength;
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
    const metadata = extractEpubMetadata(epub, bookId);
    const started = Date.now();
    const reportConversion = (message: string, etaSeconds?: number) => progress.report({ state: "转换", phase: "convert", message: `${message} · 已用 ${((Date.now() - started) / 1000).toFixed(1)} 秒`, etaSeconds });
    reportConversion("正在转换 KEPUB");
    const timer = options.progress ? setInterval(() => reportConversion("正在转换 KEPUB（耗时取决于书籍大小）"), PROGRESS_INTERVAL_MS) : undefined;
    let converted;
    try {
      // Stripping runs in the converter's worker, off the page's main thread.
      converted = await this.dependencies.converter.convert(epub, { signal: options.signal, strip: { stripFonts: options.stripFonts, stripImages: options.stripImages, stripPageMargins: options.stripPageMargins }, progress: stage => {
        reportConversion(stage === "inspecting" ? "正在读取书籍结构" : stage === "converting" ? "正在转换 KEPUB" : "KEPUB 转换完成");
      } });
    } finally { if (timer !== undefined) clearInterval(timer); }
    check();
    const filename = koboBookFilename(metadata.title || bookId), path = `Bindery/${filename}`;
    assertDeviceBookPath(path);
    return withDeviceLock(device, async () => {
      check(); progress.report({ state: "写入", phase: "write", message: "正在准备 Kobo 写入与恢复备份", loaded: 0, total: converted.data.byteLength });
      await applyDevicePatchesFor(device.root, "kobo", [{ path: ["Bindery", filename], data: converted.data }], options.signal, (_patch, value) => {
        progress.report({ state: "写入", phase: value.committing ? "finalize" : "write", message: value.committing ? "正在完成写入" : "正在写入 Kobo", loaded: value.loaded, total: value.total }, value.committing || value.loaded === value.total);
      });
      progress.report({ state: "完成", phase: "finalize", message: "已传入 Kobo" });
      return { filename, size: converted.data.byteLength };
    });
  }
}
let shared: KoboTransferService | undefined;
export const getKoboTransferService = () => shared ??= new KoboTransferService({ converter: getKepubConverter(), fetch: (...args) => fetch(...args) });
