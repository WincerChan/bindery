/// <reference lib="webworker" />
import { sanitizeEpubMemberPaths } from "../../../core/epub-safe-paths";
import { convertToKepubAsync, type KepubStats } from "../../../core/kepub";

const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<{ id: string; data: ArrayBuffer; level?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };
let busy = false;
worker.onmessage = async ({ data: request }) => {
  if (busy) { worker.postMessage({ id: request.id, error: "转换器正忙" }); return; }
  busy = true;
  try {
    // Kobo cannot open books whose member names are invalid on FAT32 (some obfuscated EPUBs use `:*|`).
    const source = sanitizeEpubMemberPaths(new Uint8Array(request.data)).data;
    const result = await convertToKepubAsync(source, { progress: stage => worker.postMessage({ id: request.id, stage }) });
    const payload: { data: Uint8Array<ArrayBuffer>; stats: KepubStats } = result;
    worker.postMessage({ id: request.id, result: payload }, [result.data.buffer]);
  } catch (error) { worker.postMessage({ id: request.id, error: `KEPUB 转换失败：${error instanceof Error ? error.message : String(error)}` }); }
  finally { busy = false; }
};
