import "./load-env.mjs";
import { serve } from "srvx";
import { createProductionHandler } from "./production-handler.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeSync } from "node:fs";

export function installShutdownHandlers(server, handler, { timeoutMs = 5000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Invalid shutdown timeout");
  let stopping;
  const shutdown = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      const deadline = Date.now() + timeoutMs;
      let timedOut = false;
      // Abort HTTP connections at the deadline. The runtime owns the bounded
      // worker shutdown; await it so its exit listener releases consumer locks.
      const timer = setTimeout(() => {
        timedOut = true;
        void server.close(true).catch(console.error);
      }, timeoutMs);
      try {
        // Stop listening and job admission together. Keep database owners alive
        // until both existing HTTP responses and the current job have finished.
        let waitForRequests;
        try { waitForRequests = server.close(); }
        catch (error) { waitForRequests = Promise.reject(error); }
        await handler.shutdown({ timeoutMs: Math.max(0, deadline - Date.now()), waitForRequests });
        if (timedOut) throw new Error("Server shutdown timed out");
        clearTimeout(timer);
        process.exit(0);
      } catch (error) {
        clearTimeout(timer);
        if (!timedOut) void server.close(true).catch(console.error);
        writeSync(2, `Server shutdown failed: ${error?.stack || error}\n`);
        process.exit(1);
      }
    })();
    return stopping;
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return shutdown;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const handler = await createProductionHandler();
  const server = serve({
    fetch: handler,
    port: Number(process.env.PORT || 3000),
    hostname: process.env.HOST || "0.0.0.0",
    // Bindery owns signal handling so workers and caches share the HTTP deadline.
    gracefulShutdown: false,
  });
  installShutdownHandlers(server, handler, { timeoutMs: Number(process.env.BINDERY_SHUTDOWN_TIMEOUT_MS || 5000) });
}
