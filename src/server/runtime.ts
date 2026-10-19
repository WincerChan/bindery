import { BinderyDatabase } from "./db";
import { LibraryStorage } from "./storage";
import { libraryPath } from "./paths";
import { writableDatabasePath } from "./database";
import { stopJobWorkers } from "./ingest/lifecycle";
import { readerArchives } from "./reader/archive";
const runtimes = new Map<string, LibraryStorage>();
let shutdown: Promise<void> | undefined;
export function isRuntimeShuttingDown(): boolean { return shutdown !== undefined; }
// Lazy: importing server modules and building the app must never touch a library.
export function getLibrary(): LibraryStorage {
  if (isRuntimeShuttingDown()) throw new Error("Runtime is shutting down");
  const base = libraryPath(),
    path = writableDatabasePath(),
    key = JSON.stringify([base, path]);
  let library = runtimes.get(key);
  if (!library) {
    library = new LibraryStorage(base, new BinderyDatabase(path));
    library.ensure();
    runtimes.set(key, library);
  }
  return library;
}

/** Terminal, idempotent shutdown. A new process recovers the durable queue. */
export function shutdownRuntime({ timeoutMs = 5000, waitForRequests = Promise.resolve() }: {
  timeoutMs?: number;
  /** The HTTP server stops listening immediately, but existing responses may drain. */
  waitForRequests?: Promise<unknown>;
} = {}): Promise<void> {
  if (shutdown) return shutdown;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new RangeError("Invalid shutdown timeout"));
  shutdown = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const requests = Promise.race([waitForRequests, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runtime shutdown timed out")), timeoutMs);
      })]);
      const results = await Promise.allSettled([stopJobWorkers({ timeoutMs }), requests]);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    finally {
      clearTimeout(timer);
      for (const library of runtimes.values()) library.db.close();
      runtimes.clear();
      readerArchives.clear();
    }
  })();
  return shutdown;
}
