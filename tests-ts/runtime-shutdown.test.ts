import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metadataFromDict } from "../src/core/models";
import { parseBook } from "../src/core/parsing";
import { buildEpub } from "../src/core/epub";
import { BinderyDatabase } from "../src/server/db";
import { LibraryStorage, epubPath, saveBook } from "../src/server/storage";

let root: string, control: Int32Array;
let runtime: typeof import("../src/server/runtime");
let lifecycle: typeof import("../src/server/ingest/lifecycle");
let library: LibraryStorage;
let holdStartup: boolean, launched: Worker[];
let starting: Promise<Worker>, onStarting: (worker: Worker) => void;
const bookId = "d".repeat(32);
beforeEach(async () => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), "bindery-shutdown-"));
  for (const name of ["BINDERY_DB_PATH", "BINDERY_LIBRARY_DIR", "BINDERY_TEMPLATE_DIR", "BINDERY_RULES_DIR", "BINDERY_THEMES_DIR"]) {
    vi.stubEnv(name, ""); vi.stubEnv(name + "_FILE", "");
  }
  vi.stubEnv("BINDERY_LIBRARY_DIR", join(root, "library"));
  vi.stubEnv("BINDERY_DB_PATH", join(root, "data.db"));
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(root, "templates"));
  control = new Int32Array(new SharedArrayBuffer(12));
  holdStartup = false;
  launched = [];
  starting = new Promise(resolve => { onStarting = resolve; });
  vi.doMock("../src/server/ingest/executor", () => ({
    launchWorker(storage: LibraryStorage, stopSignal: Int32Array) {
      const worker = new Worker(pathToFileURL(resolve("tests-ts/fixtures/shutdown/worker.mjs")), {
        execArgv: ["--experimental-transform-types"],
        workerData: { binderyIngest: true, module: pathToFileURL(resolve("src/server/ingest/executor.ts")).href, base: storage.base, database: storage.db.path, stopSignal, control, holdStartup },
      });
      launched.push(worker);
      worker.once("message", message => { if (message === "starting") onStarting(worker); });
      return worker;
    },
  }));
  runtime = await import("../src/server/runtime");
  lifecycle = await import("../src/server/ingest/lifecycle");
  library = runtime.getLibrary();
  const meta = metadataFromDict({ book_id: bookId, title: "关闭测试", source_type: "epub", theme_template: "__book__" });
  library.saveMetadata(meta);
  const book = parseBook("第一章 开始\n正文", meta.title);
  saveBook(book, library.base, bookId);
  writeFileSync(epubPath(library.base, bookId), buildEpub(book, meta));
});
afterEach(async () => {
  Atomics.store(control, 1, 1);
  Atomics.store(control, 2, 1);
  Atomics.notify(control, 2);
  await runtime.shutdownRuntime().catch(() => {});
  vi.doUnmock("../src/server/ingest/executor");
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
async function queuePair() {
  const { enqueueEditWriteback } = await import("../src/server/jobs");
  const options = { book_id: bookId, cover_bytes: null, cover_name: null, strip_original_css: false, strip_fonts: false };
  const first = enqueueEditWriteback({ ...options, cover_url: "https://cover.invalid/test.png" }, library).job;
  const next = enqueueEditWriteback({ ...options, cover_url: "" }, library).job;
  lifecycle.startJobWorker(library);
  await vi.waitFor(() => expect(Atomics.load(control, 0)).toBe(1), { timeout: 15000 });
  return { first, next };
}
async function restart(database: BinderyDatabase, nextId: string) {
  vi.resetModules();
  const { startJobWorker, stopJobWorker } = await import("../src/server/ingest/lifecycle");
  const storage = new LibraryStorage(library.base, database);
  startJobWorker(storage);
  try {
    await vi.waitFor(() => expect(database.getJob(nextId)?.status).toBe("success"), { timeout: 15000 });
  } finally { await stopJobWorker(storage); }
}

it("finishes only the in-flight job, rejects new jobs, and resumes the durable queue after restart", async () => {
  const { first, next } = await queuePair();
  const pending = runtime.shutdownRuntime({ timeoutMs: 10000 });
  expect(runtime.shutdownRuntime()).toBe(pending);
  const { enqueueJob } = await import("../src/server/jobs");
  expect(() => enqueueJob({ book_id: bookId }, library)).toThrow("服务正在关闭");
  expect(library.db.getJob(first.id)?.status).toBe("running");
  Atomics.store(control, 1, 1);
  await pending;
  expect(() => library.db.listJobs()).toThrow("Database is closed");
  const database = new BinderyDatabase(library.db.path);
  expect(database.getJob(first.id)?.status).toBe("success");
  expect(database.getJob(next.id)).toMatchObject({ status: "running", stage: "排队中" });
  expect(existsSync(join(library.base, ".ingest-queue", next.id, "task.json"))).toBe(true);
  expect(existsSync(join(library.base, ".ingest-queue", ".consumer"))).toBe(false);
  await restart(database, next.id);
  expect(database.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  database.close();
});

it("terminates on timeout and recovers the interrupted job while preserving queued work", async () => {
  const { first, next } = await queuePair();
  const pending = runtime.shutdownRuntime({ timeoutMs: 20 });
  await expect(pending).rejects.toThrow("Runtime shutdown timed out");
  expect(runtime.shutdownRuntime()).toBe(pending);
  const database = new BinderyDatabase(library.db.path);
  expect(database.getJob(first.id)).toMatchObject({ status: "running" });
  expect(database.getJob(next.id)).toMatchObject({ status: "running", stage: "排队中" });
  expect(existsSync(join(library.base, ".ingest-queue", first.id, "task.json"))).toBe(true);
  Atomics.store(control, 1, 1);
  await restart(database, next.id);
  expect(database.getJob(first.id)).toMatchObject({ status: "failed", message: "后台处理被中断，请重试" });
  expect(new LibraryStorage(library.base, database).loadMetadata(bookId).status).toBe("synced");
  expect(database.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  database.close();
});

it("cancels a worker blocked in bootstrap before job admission and awaits its exit", async () => {
  holdStartup = true;
  const { enqueueEditWriteback } = await import("../src/server/jobs");
  const { job } = enqueueEditWriteback({ book_id: bookId, cover_bytes: null, cover_name: null, cover_url: "", strip_original_css: false, strip_fonts: false }, library);
  lifecycle.startJobWorker(library);
  const worker = await starting;
  const pending = runtime.shutdownRuntime();
  expect(runtime.shutdownRuntime()).toBe(pending);
  await pending;
  // Bootstrap was never released: completing shutdown requires cancellation,
  // not waiting for a guessed startup duration or abandoning a live thread.
  expect(Atomics.load(control, 2)).toBe(0);
  expect(worker.threadId).toBe(-1);
  expect(existsSync(join(library.base, ".ingest-queue", ".consumer"))).toBe(false);
  expect(() => library.db.listJobs()).toThrow("Database is closed");
  const database = new BinderyDatabase(library.db.path);
  try {
    expect(database.getJob(job.id)).toMatchObject({ status: "running", stage: "排队中" });
    expect(existsSync(join(library.base, ".ingest-queue", job.id, "task.json"))).toBe(true);
    holdStartup = false;
    await restart(database, job.id);
    expect(database.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  } finally { database.close(); }
});

it("cancels pending lazy launch, clears archive caches, closes DB handles, and permits immediate removal", async () => {
  const { readerArchives } = await import("../src/server/reader/archive");
  expect(readerArchives.get(epubPath(library.base, bookId))).toBeDefined();
  let handle: import("node:sqlite").DatabaseSync | undefined;
  library.db.withConnection(connection => { handle = connection; });
  expect(handle?.isOpen).toBe(false);
  lifecycle.startJobWorker(library);
  const pending = runtime.shutdownRuntime();
  expect(runtime.shutdownRuntime()).toBe(pending);
  await pending;
  expect(launched).toHaveLength(0);
  expect(readerArchives.size).toBe(0);
  expect(() => runtime.getLibrary()).toThrow("Runtime is shutting down");
  expect(() => library.db.init()).toThrow("Database is closed");
  // Start attempts after shutdown cannot recreate anything after cleanup.
  lifecycle.startJobWorker(library);
  rmSync(root, { recursive: true, force: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(existsSync(root)).toBe(false);
});

it("shuts down every library owned by the runtime", async () => {
  vi.stubEnv("BINDERY_LIBRARY_DIR", join(root, "second-library"));
  vi.stubEnv("BINDERY_DB_PATH", join(root, "second.db"));
  const second = runtime.getLibrary();
  lifecycle.startJobWorker(library);
  lifecycle.startJobWorker(second);
  let finishRequests!: () => void;
  const waitForRequests = new Promise<void>(resolve => { finishRequests = resolve; });
  const stopped = runtime.shutdownRuntime({ waitForRequests });
  await new Promise(resolve => setTimeout(resolve, 100));
  // Admitted HTTP work can still read until its response has drained.
  expect(second.db.listJobs()).toEqual([]);
  finishRequests();
  await stopped;
  expect(() => library.db.listJobs()).toThrow("Database is closed");
  expect(() => second.db.listJobs()).toThrow("Database is closed");
  rmSync(root, { recursive: true, force: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(existsSync(root)).toBe(false);
});
