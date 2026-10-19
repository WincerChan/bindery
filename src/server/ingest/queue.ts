import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "../../core/models";
import type { LibraryStorage } from "../storage";
import { nowIso } from "../db";
import { readEnv } from "../env";
import { queueDirectory, validId } from "./staging";
import { processJob, updateJob } from "./processor";

/** Conditional UPDATE is the ownership boundary, even across Node processes. */
export function claimJob(library: LibraryStorage): Job | null {
  return library.db.get<Job>(`UPDATE jobs SET stage = '预处理', updated_at = ? WHERE id =
    (SELECT id FROM jobs WHERE status = 'running' AND stage = '排队中' ORDER BY created_at, rowid LIMIT 1)
    AND status = 'running' AND stage = '排队中' RETURNING *`, nowIso());
}
/** Called only while holding the per-library process lock. No live consumer is interrupted. */
export function recoverJobs(library: LibraryStorage): void {
  for (const job of library.db.listJobs("running")) if (job.stage !== "排队中") {
    updateJob(library, job.id, { status: "failed", stage: "失败", message: "后台处理被中断，请重试" });
    if (job.book_id && library.ensureBookExists(job.book_id)) {
      const meta = library.loadMetadata(job.book_id); meta.status = "failed"; meta.updated_at = nowIso(); library.saveMetadata(meta);
    }
  }
  const root = join(library.base, ".ingest-queue");
  if (!existsSync(root)) return;
  const requests = join(root, ".requests");
  if (existsSync(requests)) for (const entry of readdirSync(requests, { withFileTypes: true })) if (entry.isDirectory() && Date.now() - statSync(join(requests, entry.name)).mtimeMs > 86400000) rmSync(join(requests, entry.name), { recursive: true, force: true });
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && validId(entry.name)) {
    const job = library.db.getJob(entry.name);
    // Unpublished directories may belong to an upload in progress. Allow one day.
    if (job ? job.status !== "running" : Date.now() - statSync(join(root, entry.name)).mtimeMs > 86400000) rmSync(queueDirectory(library, entry.name), { recursive: true, force: true });
  }
}
export function memoryTrimEnabled(): boolean { const raw = readEnv("BINDERY_MEMORY_TRIM"); return raw === undefined || ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase()); }
export function trimMemory(gc = (globalThis as typeof globalThis & { gc?: () => void }).gc): void { if (memoryTrimEnabled()) gc?.(); }
export async function drainJobs(library: LibraryStorage, fetcher?: import("../books/metadata-lookup").Fetch): Promise<number> {
  let count = 0, job: Job | null;
  while ((job = claimJob(library))) { try { await processJob(library, job, fetcher); } finally { trimMemory(); } count++; }
  return count;
}
/** A process lock serializes dedupe and recovery; claims still use SQLite CAS. */
export function acquireConsumer(library: LibraryStorage): (() => void) | null {
  library.ensure();
  return library.db.withConnection(conn => {
    conn.exec("BEGIN IMMEDIATE");
    try { return acquireConsumerLock(library); } finally { conn.exec("COMMIT"); }
  });
}
function acquireConsumerLock(library: LibraryStorage): (() => void) | null {
  const root = join(library.base, ".ingest-queue"), lock = join(root, ".consumer");
  mkdirSync(root, { recursive: true });
  try { mkdirSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: number;
    try { owner = Number(readFileSync(join(lock, "pid"), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; if (Date.now() - statSync(lock).mtimeMs < 30000) return null; owner = 0; }
    if (owner > 0) { try { process.kill(owner, 0); return null; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") return null; } }
    try { rmSync(lock, { recursive: true, force: true }); mkdirSync(lock); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return null; throw e; }
  }
  writeFileSync(join(lock, "pid"), String(process.pid));
  return () => rmSync(lock, { recursive: true, force: true });
}
