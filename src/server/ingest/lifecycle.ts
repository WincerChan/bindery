import type { Worker } from "node:worker_threads";
import type { LibraryStorage } from "../storage";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

interface Consumer {
  signal: Int32Array;
  worker: Promise<Worker>;
  stopping?: Promise<void>;
}
const workers = new Map<string, Consumer>();
let shuttingDown = false;
const workerKey = (library: LibraryStorage) => JSON.stringify([library.base, library.db.path]);

/** Per library, lazy, idempotent; parsing/ZIP work never runs on the HTTP thread. */
export function startJobWorker(library: LibraryStorage): void {
  const key = workerKey(library);
  if (shuttingDown || workers.has(key)) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const consumer: Consumer = { signal, worker: import("./executor").then(({ launchWorker }) => {
    const worker = launchWorker(library, signal);
    worker.unref();
    worker.on("error", error => console.error("ingest worker:", error));
    worker.on("exit", () => {
      if (workers.get(key) === consumer) workers.delete(key);
      const lock = join(library.base, ".ingest-queue", ".consumer");
      try {
        if (Number(readFileSync(join(lock, "pid"), "utf8")) === process.pid) rmSync(lock, { recursive: true, force: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    });
    return worker;
  }).catch(error => { workers.delete(key); throw error; }) };
  workers.set(key, consumer);
  void consumer.worker.catch(error => console.error("ingest worker startup:", error));
}

export function stopJobWorker(library: LibraryStorage, { timeoutMs = 5000 } = {}): Promise<void> {
  const consumer = workers.get(workerKey(library));
  return consumer ? stopConsumer(consumer, timeoutMs) : Promise.resolve();
}

function stopConsumer(consumer: Consumer, timeoutMs: number): Promise<void> {
  if (consumer.stopping) return consumer.stopping;
  // A message alone cannot interrupt a drain loop of synchronous jobs/microtasks.
  Atomics.store(consumer.signal, 0, 1);
  consumer.stopping = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = consumer.worker.then(async worker => {
      if (worker.threadId === -1) return;
      await new Promise<void>(resolve => {
        worker.once("exit", () => resolve());
        worker.ref();
        worker.postMessage("stop");
      });
    });
    try {
      await Promise.race([stopped, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runtime shutdown timed out")), timeoutMs);
      })]);
    } catch (error) {
      // Await thread exit before callers may remove the library. SQLite rolls
      // back interrupted transactions; recoverJobs handles the durable job row.
      const worker = await consumer.worker;
      if (worker.threadId !== -1) await worker.terminate();
      throw error;
    } finally { clearTimeout(timer); }
  })();
  return consumer.stopping;
}

export async function stopJobWorkers({ timeoutMs = 5000 } = {}): Promise<void> {
  shuttingDown = true;
  const results = await Promise.allSettled([...workers.values()].map(consumer => stopConsumer(consumer, timeoutMs)));
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
