import type { KepubStats } from "../../../core/kepub";

export type KepubStage = "inspecting" | "converting" | "done";
export interface KepubConversionResult { data: Uint8Array<ArrayBuffer>; stats: KepubStats }
export interface KepubConversionOptions { signal?: AbortSignal; progress?: (stage: KepubStage) => void }
export interface KepubConverter { convert(data: Uint8Array, options?: KepubConversionOptions): Promise<KepubConversionResult> }
/** One Worker/job. Termination is the cancellation boundary because conversion is synchronous. */
export class KepubWorkerConverter implements KepubConverter {
  private active = false;
  constructor(private createWorker = () => new Worker(new URL("./kepub-worker.ts", import.meta.url), { type: "module" }), private level: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 1) {}
  async convert(data: Uint8Array, options: KepubConversionOptions = {}): Promise<KepubConversionResult> {
    if (this.active) throw new Error("已有 KEPUB 转换正在进行，请稍后重试");
    if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError");
    this.active = true;
    let worker: Worker | undefined;
    try {
      worker = this.createWorker();
      return await new Promise<KepubConversionResult>((resolve, reject) => {
        const id = crypto.randomUUID(), abort = () => { cleanup(); reject(new DOMException("操作已取消", "AbortError")); };
        options.signal?.addEventListener("abort", abort, { once: true });
        const cleanup = () => options.signal?.removeEventListener("abort", abort);
        worker!.onerror = event => { cleanup(); reject(new Error(`KEPUB 转换器异常：${event.message || "Worker 无法加载"}`)); };
        worker!.onmessageerror = () => { cleanup(); reject(new Error("KEPUB 转换器返回了无效消息")); };
        worker!.onmessage = ({ data: message }) => {
          if (message.id !== id) return;
          if (message.error) { cleanup(); reject(new Error(message.error)); }
          else if (message.result) { cleanup(); resolve(message.result); }
          else if (message.stage) options.progress?.(message.stage);
        };
        const input = new Uint8Array(data);
        worker!.postMessage({ id, data: input.buffer, level: this.level }, [input.buffer]);
        if (options.signal?.aborted) { cleanup(); abort(); }
      });
    } finally { worker?.terminate(); this.active = false; }
  }
}
let shared: KepubWorkerConverter | undefined;
export const getKepubConverter = () => shared ??= new KepubWorkerConverter();
