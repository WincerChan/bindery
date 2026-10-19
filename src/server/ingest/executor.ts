import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { LibraryStorage } from "../storage";
import { BinderyDatabase } from "../db";
import { acquireConsumer, drainJobs, recoverJobs } from "./queue";

/** The dynamic import keeps this module as an executable chunk in the SSR build. */
export function launchWorker(library: LibraryStorage): Worker {
  const bootstrap = `
    const { workerData } = require('node:worker_threads');
    // Node 24 can execute our dev source directly. Production imports the Vite chunk.
    if (workerData.module.endsWith('.ts')) require('node:module').registerHooks({
      resolve(specifier, context, next) {
        try { return next(specifier, context); } catch (error) {
          if (['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error.code) && specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
            try { return next(specifier + '.ts', context); } catch { return next(specifier + '/index.ts', context); }
          }
          throw error;
        }
      }
    });
    import(workerData.module).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  return new Worker(bootstrap, { eval: true, execArgv: ["--experimental-transform-types"], workerData: { binderyIngest: true, module: import.meta.url, base: library.base, database: library.db.path } });
}
if (!isMainThread && workerData?.binderyIngest && workerData.module === import.meta.url) {
  const library = new LibraryStorage(workerData.base, new BinderyDatabase(workerData.database));
  let release: (() => void) | null = null;
  let busy = false, stopping = false;
  const timer = setInterval(() => void tick(), 250);
  function stop() { clearInterval(timer); if (!busy) { release?.(); release = null; parentPort?.close(); } }
  async function tick() {
    if (busy || stopping) return;
    busy = true;
    try {
      if (!release) { release = acquireConsumer(library); if (!release) return; library.ensure(); recoverJobs(library); }
      await drainJobs(library);
    } catch (error) { console.error("ingest worker:", error); }
    finally { busy = false; if (stopping) stop(); }
  }
  parentPort?.on("message", message => { if (message === "stop") { stopping = true; stop(); } });
  tick();
}
