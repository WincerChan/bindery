import { nowIso, type VocabularyRow } from "../db";
import type { LibraryStorage } from "../storage";
import { lexTraceSettings } from "./settings";
import type { VocabularyContext } from "./input";

const MAX_ATTEMPTS = 5, BASE_DELAY_MS = 5000, MAX_DELAY_MS = 60 * 60 * 1000, MAX_BODY_BYTES = 256 * 1024;
export interface PushPayload {
  lookup_id: string;
  source_text: string;
  context: VocabularyContext;
  source: string;
  looked_up_at: string;
  meta: { media_title: string };
}
export interface PushOptions {
  fetcher?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  waitForRetry?: boolean;
}
export interface PushResult { configured: boolean; attempted: number; pushed: number; conflicts: number; errors: number }
interface PushStatus { status?: string; http?: number; category?: string; attempts?: number; retryable?: boolean; next_attempt_at?: string }
type Outcome = "pushed" | "conflict" | "deleted" | "permanent" | "transient";

const control = /[\u0000-\u001f\u007f-\u009f]+/g;
export function sanitizeSource(value: string): string {
  const clean = value.replace(control, " ").replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean === "." || clean === "..") return "Bindery";
  return clean.slice(0, 255).trim() || "Bindery";
}
function mediaTitle(value: string): string {
  return value.replace(control, " ").replace(/\s+/g, " ").trim().slice(0, 2048) || "Bindery";
}
function text(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}
function contextOf(row: VocabularyRow): VocabularyContext {
  let raw: unknown = null;
  if (row.context_json) {
    try { raw = JSON.parse(row.context_json); } catch { raw = null; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { sentence: "", previous: [], following: [] };
  const value = raw as Record<string, unknown>;
  const list = (input: unknown) => Array.isArray(input) ? input.filter((item): item is string => typeof item === "string").slice(0, 64).map(item => item.slice(0, 8192)) : [];
  return { sentence: text(value.sentence, 32768), previous: list(value.previous), following: list(value.following) };
}
function titleOf(library: LibraryStorage, row: VocabularyRow): string {
  if (row.book_id) {
    try { return library.loadMetadata(row.book_id).title || row.source_title; }
    catch { /* Deleted or archived book: keep the device's source label. */ }
  }
  return row.source_title;
}
const encodedLength = (value: string) => new TextEncoder().encode(value).length;
function requestBody(payload: PushPayload): string {
  let body = JSON.stringify(payload);
  if (encodedLength(body) <= MAX_BODY_BYTES) return body;
  const context: VocabularyContext = { sentence: payload.context.sentence, previous: [...payload.context.previous], following: [...payload.context.following] };
  const sized = () => JSON.stringify({ ...payload, context });
  while (encodedLength(body = sized()) > MAX_BODY_BYTES && (context.previous.length || context.following.length)) {
    if (context.following.length) context.following.pop();
    else context.previous.shift();
  }
  while (encodedLength(body) > MAX_BODY_BYTES && context.sentence.length) {
    context.sentence = context.sentence.slice(0, Math.floor(context.sentence.length * 0.75));
    body = sized();
  }
  return body;
}
export function vocabularyPushPayload(library: LibraryStorage, row: VocabularyRow): PushPayload {
  const title = titleOf(library, row), sourceText = (row.word || row.raw_word).slice(0, 512).trim() || "word";
  const parsed = Date.parse(row.looked_up_at);
  return {
    lookup_id: row.id,
    source_text: sourceText,
    context: contextOf(row),
    source: sanitizeSource(title),
    looked_up_at: Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString(),
    meta: { media_title: mediaTitle(title) },
  };
}
function statusOf(row: VocabularyRow): PushStatus {
  if (!row.push_status_json) return {};
  try {
    const value = JSON.parse(row.push_status_json) as PushStatus;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
function delayFor(attempts: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}
function classify(status: number): Outcome {
  if (status === 200 || status === 202) return "pushed";
  if (status === 410) return "deleted";
  if (status === 409) return "conflict";
  if (status === 503 || status === 429 || status >= 500) return "transient";
  return "permanent";
}
async function pushOne(library: LibraryStorage, row: VocabularyRow, options: PushOptions, config: ReturnType<typeof lexTraceSettings>): Promise<{ outcome: Outcome; delay: number; attempts: number }> {
  const attempts = (statusOf(row).attempts ?? 0) + 1, payload = vocabularyPushPayload(library, row), now = options.now?.() ?? new Date();
  const update = (state: string, status: PushStatus, pushedAt: string | null) => library.db.updateVocabularyPush(row.id, state, JSON.stringify(status), pushedAt, nowIso(now));
  let outcome: Outcome, http: number | undefined, category: string | undefined;
  try {
    const response = await (options.fetcher ?? fetch)(`${config.baseUrl}/api/integrations/llplayer/lookups`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: requestBody(payload),
      redirect: "error",
    });
    http = response.status;
    outcome = classify(response.status);
  } catch {
    outcome = "transient"; category = "network";
  }
  if (outcome === "pushed") {
    update("pushed", { status: http === 202 ? "queued" : "saved", http: http ?? 200, attempts }, nowIso(now));
    return { outcome, delay: 0, attempts };
  }
  if (outcome === "deleted") {
    update("pushed", { status: "deleted", http: 410, attempts }, nowIso(now));
    return { outcome, delay: 0, attempts };
  }
  if (outcome === "conflict") {
    update("conflict", { status: "conflict", http: 409, attempts, retryable: false }, null);
    return { outcome, delay: 0, attempts };
  }
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS, retryable = outcome === "transient" && attempts < maxAttempts;
  const delay = retryable ? delayFor(attempts) : 0;
  update("error", {
    status: "error",
    ...(http === undefined ? {} : { http }),
    ...(category || outcome === "permanent" ? { category: category ?? "http" } : {}),
    attempts,
    retryable,
    ...(retryable ? { next_attempt_at: new Date(now.getTime() + delay).toISOString() } : {}),
  }, null);
  return { outcome: retryable ? "transient" : "permanent", delay, attempts };
}
function due(row: VocabularyRow, now: number): boolean {
  const status = statusOf(row);
  if (status.retryable === false) return false;
  if (!status.next_attempt_at) return true;
  const at = Date.parse(status.next_attempt_at);
  return !Number.isFinite(at) || at <= now;
}

/** Oldest first, one request at a time; retryable failures back off without blocking other words. */
export async function pushVocabulary(library: LibraryStorage, options: PushOptions = {}): Promise<PushResult> {
  const config = lexTraceSettings(library.db), result: PushResult = { configured: Boolean(config.enabled && config.baseUrl && config.token), attempted: 0, pushed: 0, conflicts: 0, errors: 0 };
  if (!result.configured) return result;
  const now = () => (options.now?.() ?? new Date()).getTime();
  for (let guard = 0; guard < 50000; guard++) {
    const row = library.db.listVocabularyForPush().find(item => due(item, now()));
    if (!row) break;
    result.attempted++;
    const outcome = await pushOne(library, row, options, config);
    if (outcome.outcome === "pushed" || outcome.outcome === "deleted") result.pushed++;
    else if (outcome.outcome === "conflict") result.conflicts++;
    else result.errors++;
    if (outcome.outcome === "transient" && options.waitForRetry && outcome.delay > 0) {
      await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(outcome.delay);
    }
  }
  return result;
}

const KEY = Symbol.for("bindery.vocabulary.push.worker");
interface WorkerState { running: Map<string, Promise<void>>; timers: Map<string, ReturnType<typeof setTimeout>> }
const workerState: WorkerState = ((globalThis as unknown as Record<symbol, WorkerState>)[KEY] ??= { running: new Map(), timers: new Map() });
const keyOf = (library: LibraryStorage) => JSON.stringify([library.base, library.db.path]);

function schedule(library: LibraryStorage): void {
  const key = keyOf(library), current = workerState.timers.get(key);
  if (current) clearTimeout(current);
  const now = Date.now(), next = library.db.listVocabularyForPush().map(row => {
    const status = statusOf(row);
    if (status.retryable === false || !status.next_attempt_at) return Infinity;
    const at = Date.parse(status.next_attempt_at);
    return Number.isFinite(at) ? at : Infinity;
  }).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (!Number.isFinite(next)) return;
  const timer = setTimeout(() => { workerState.timers.delete(key); kickVocabularyPush(library); }, Math.max(0, Math.min(2 ** 31 - 1, next - now)));
  timer.unref?.();
  workerState.timers.set(key, timer);
}

/** Fire-and-forget trigger used after syncs/settings changes; no token ever reaches logs. */
export function kickVocabularyPush(library: LibraryStorage): Promise<void> {
  const key = keyOf(library), running = workerState.running.get(key);
  if (running) return running;
  const task = pushVocabulary(library).then(() => schedule(library)).catch(error => { console.error("vocabulary push:", error instanceof Error ? error.name : "failed"); });
  workerState.running.set(key, task);
  void task.finally(() => workerState.running.delete(key));
  return task;
}
export function retryVocabularyPush(library: LibraryStorage, ids?: string[]): number {
  const changed = library.db.resetVocabularyPush(ids);
  void kickVocabularyPush(library);
  return changed;
}
export { MAX_ATTEMPTS, BASE_DELAY_MS, MAX_DELAY_MS, MAX_BODY_BYTES };
