import wasmUrl from "../../../vendor/boko/boko_bg.wasm?url";
import { convertEpub } from "./conversion";
import { errorMessage } from "../kindle/fs";

const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<{ id: string; data: ArrayBuffer }>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };
let busy = false;
worker.onmessage = async ({ data: request }) => {
  if (busy) { worker.postMessage({ id: request.id, error: "转换器正忙" }); return; }
  busy = true;
  try {
    const result = await convertEpub(new Uint8Array(request.data), wasmUrl, stage => worker.postMessage({ id: request.id, stage }));
    worker.postMessage({ id: request.id, result }, [result.data.buffer]);
  } catch (error) { worker.postMessage({ id: request.id, error: `KFX 转换失败：${errorMessage(error)}` }); }
  finally { busy = false; }
};
