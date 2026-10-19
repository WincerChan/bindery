import type { ConversionResult, ConversionStage } from "./conversion";

export interface ConversionOptions { signal?: AbortSignal; progress?: (stage: ConversionStage) => void }
export interface EpubConverter { convert(data: Uint8Array, options?: ConversionOptions): Promise<ConversionResult> }
/** One Worker/job. Termination is required: synchronous WASM cannot process a cancel message. */
export class BokoConverter implements EpubConverter {
  private active = false;
  constructor(private createWorker = () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })) {}
  async convert(data: Uint8Array, options: ConversionOptions = {}): Promise<ConversionResult> {
    if (this.active) throw new Error("已有 KFX 转换正在进行，请稍后重试");
    if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError");
    this.active = true;
    let worker: Worker | undefined;
    try {
      worker = this.createWorker();
      return await new Promise<ConversionResult>((resolve, reject) => {
        const id = crypto.randomUUID(), abort = () => { cleanup(); reject(new DOMException("操作已取消", "AbortError")); };
        options.signal?.addEventListener("abort", abort, { once: true });
        const cleanup = () => options.signal?.removeEventListener("abort", abort);
        worker!.onerror = event => { cleanup(); reject(new Error(`KFX 转换器异常：${event.message || "WASM 无法加载"}`)); };
        worker!.onmessageerror = () => { cleanup(); reject(new Error("KFX 转换器返回了无效消息")); };
        worker!.onmessage = ({ data: message }) => {
          if (message.id !== id) return;
          if (message.error) { cleanup(); reject(new Error(message.error)); }
          else if (message.result) { cleanup(); resolve(message.result); }
          else if (message.stage) options.progress?.(message.stage);
        };
        // Copy before transfer so callers retain the original EPUB buffer.
        const input = new Uint8Array(data); worker!.postMessage({ id, data: input.buffer }, [input.buffer]);
        if (options.signal?.aborted) { cleanup(); abort(); }
      });
    } finally { worker?.terminate(); this.active = false; }
  }
}
let shared: BokoConverter | undefined;
export const getBokoConverter = () => shared ??= new BokoConverter();
