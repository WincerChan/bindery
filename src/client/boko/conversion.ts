import init, { book_info, convert } from "../../../vendor/boko/boko.js";
import type { InitInput } from "../../../vendor/boko/boko.js";
import { readKfxIdentity, type KfxIdentity } from "./kfx";

export type ConversionStage = "loading" | "inspecting" | "converting" | "metadata" | "done";
export interface ConversionResult { data: Uint8Array<ArrayBuffer>; identity: KfxIdentity; bookInfo: { title: string; authors: string[]; language: string; chapters: number; toc_entries: number } }
let initialized: Promise<unknown> | undefined;
/** Browser calls this only in the Worker. Node tests supply WASM bytes directly. */
export async function convertEpub(data: Uint8Array, wasm: InitInput, progress: (stage: ConversionStage) => void = () => {}): Promise<ConversionResult> {
  progress("loading");
  initialized ??= init({ module_or_path: wasm }).catch(error => { initialized = undefined; throw error; });
  await initialized;
  progress("inspecting");
  const bookInfo = JSON.parse(book_info(data, "epub"));
  progress("converting");
  const converted = new Uint8Array(convert(data, "epub", "kfx"));
  progress("metadata");
  const identity = readKfxIdentity(converted);
  progress("done");
  return { data: converted, identity, bookInfo };
}
