import { registerHooks } from "node:module";
import { workerData } from "node:worker_threads";
import { setTimeout } from "node:timers/promises";

// Execute the real executor/queue/processor. Only the external cover transport is
// replaced with a controllable local gate; these tests never open a socket.
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(error.code) && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try { return next(specifier + ".ts", context); }
        catch { return next(specifier + "/index.ts", context); }
      }
      throw error;
    }
  },
});
globalThis.fetch = async () => {
  Atomics.store(workerData.control, 0, 1);
  while (!Atomics.load(workerData.control, 1)) await setTimeout(5);
  return new Response(Buffer.from("89504e470d0a1a0a", "hex"));
};
await import(workerData.module);
