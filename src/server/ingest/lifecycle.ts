import type { LibraryStorage } from "../storage";

/** Slice C owns this extension point. Called on requests; must stay idempotent,
 * non-blocking and lazy. No worker is implemented by the Phase 3 foundation. */
export function startJobWorker(_library: LibraryStorage): void {}
