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
  const timer = setInterval(tick, 250);
  function tick() {
    try {
      if (!release) { release = acquireConsumer(library); if (!release) return; library.ensure(); recoverJobs(library); }
      drainJobs(library);
    } catch (error) { console.error("ingest worker:", error); }
  }
  parentPort?.on("message", message => { if (message === "stop") { clearInterval(timer); release?.(); release = null; parentPort?.close(); } });
  tick();
}
