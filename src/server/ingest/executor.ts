import { Worker, isMainThread, workerData } from "node:worker_threads";
import type { LibraryStorage } from "../storage";

/** The dynamic import keeps this module as an executable chunk in the SSR build. */
export function launchWorker(library: LibraryStorage, stopSignal: Int32Array): Worker {
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
  return new Worker(bootstrap, { eval: true, execArgv: ["--experimental-transform-types"], workerData: { binderyIngest: true, module: import.meta.url, base: library.base, database: library.db.path, stopSignal } });
}
if (!isMainThread && workerData?.binderyIngest && workerData.module === import.meta.url) {
  // Keep the launcher cheap on the HTTP thread. The parser/ZIP dependency graph
  // loads only in the worker, while startup is still safely cancellable.
  const { runJobConsumer } = await import("./consumer");
  runJobConsumer(workerData.base, workerData.database, workerData.stopSignal);
}
