/// <reference lib="webworker" />
import type { KoboProfile } from "../../../core/kobo-kepub";
import type { KepubStats } from "../../../core/kepub";
import { convertForKobo } from "../../../core/kobo-kepub";

const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<{ id: string; data: ArrayBuffer; profile?: KoboProfile; level?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };
let busy = false;
worker.onmessage = async ({ data: request }) => {
  if (busy) { worker.postMessage({ id: request.id, error: "转换器正忙" }); return; }
  busy = true;
  try {
    const result = await convertForKobo(new Uint8Array(request.data), { profile: request.profile, progress: stage => worker.postMessage({ id: request.id, stage }) });
    const payload: { data: Uint8Array<ArrayBuffer>; stats: KepubStats } = result;
    worker.postMessage({ id: request.id, result: payload }, [result.data.buffer]);
  } catch (error) { worker.postMessage({ id: request.id, error: `KEPUB 转换失败：${error instanceof Error ? error.message : String(error)}` }); }
  finally { busy = false; }
};
