import type { Worker } from "node:worker_threads";
import type { LibraryStorage } from "../storage";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const workers = new Map<string, Promise<Worker>>();
/** Per library, lazy, idempotent; parsing/ZIP work never runs on the HTTP thread. */
export function startJobWorker(library: LibraryStorage): void {
  const key = JSON.stringify([library.base, library.db.path]);
  if (workers.has(key)) return;
  const promise = import("./executor").then(({ launchWorker }) => {
    const worker = launchWorker(library);
    worker.unref();
    worker.on("error", error => console.error("ingest worker:", error));
    worker.on("exit", () => {
      workers.delete(key);
      const lock = join(library.base, ".ingest-queue", ".consumer");
      if (existsSync(join(lock, "pid")) && Number(readFileSync(join(lock, "pid"), "utf8")) === process.pid) rmSync(lock, { recursive: true, force: true });
    });
    return worker;
  }).catch(error => { workers.delete(key); throw error; });
  workers.set(key, promise);
  void promise.catch(error => console.error("ingest worker startup:", error));
}
export async function stopJobWorker(library: LibraryStorage): Promise<void> {
  const key = JSON.stringify([library.base, library.db.path]), pending = workers.get(key);
  if (!pending) return;
  const worker = await pending;
  if (worker.threadId === -1) return;
  await new Promise<void>(resolve => { worker.once("exit", () => resolve()); worker.postMessage("stop"); });
}
