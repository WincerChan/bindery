import { parentPort } from "node:worker_threads";
import { LibraryStorage } from "../storage";
import { BinderyDatabase } from "../db";
import { acquireConsumer, drainJobs, recoverJobs } from "./queue";
import { WorkerState } from "./worker-state";

export function runJobConsumer(base: string, database: string, stopSignal: Int32Array): void {
  // Until this transition wins, shutdown may terminate bootstrap without
  // interrupting a job or touching a library. Never overwrite a stop request.
  if (Atomics.compareExchange(stopSignal, 0, WorkerState.Starting, WorkerState.Running) !== WorkerState.Starting) return;
  const library = new LibraryStorage(base, new BinderyDatabase(database));
  const shouldStop = () => stopping || Atomics.load(stopSignal, 0) === WorkerState.Stopping;
  let release: (() => void) | null = null;
  let busy = false, stopping = false;
  const timer = setInterval(() => void tick(), 250);
  function stop() {
    clearInterval(timer);
    if (!busy) {
      try { release?.(); } finally { release = null; library.db.close(); parentPort?.close(); }
    }
  }
  async function tick() {
    if (busy) return;
    if (shouldStop()) { stop(); return; }
    busy = true;
    try {
      if (!release) { release = acquireConsumer(library); if (!release) return; library.ensure(); recoverJobs(library); }
      await drainJobs(library, undefined, shouldStop);
    } catch (error) { console.error("ingest worker:", error); }
    finally { busy = false; if (shouldStop()) stop(); }
  }
  parentPort?.on("message", message => { if (message === "stop") { stopping = true; stop(); } });
  tick();
}
