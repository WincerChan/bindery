import { newBookId } from "./storage";
import { getLibrary, isRuntimeShuttingDown } from "./runtime";
import { nowIso } from "./db";
import { readEnv } from "./env";
import { HttpError } from "./http";
import type { Job } from "../core/models";
import { rmSync } from "node:fs";
import { stageEditWriteback, loadEditWriteback, type EditWritebackOptions } from "./ingest/edit-staging";
import { queueDirectory } from "./ingest/staging";

export type JobAction = "regenerate" | "retry" | "edit-writeback" | "upload" | "upload-epub" | "ingest";
export interface EnqueueInput {
  /** Stage upload payload under this ID before publishing the row. */
  id?: string;
  book_id: string | null;
  rule_template?: string | null;
  action?: JobAction;
}
/** Complete durable files first, then atomically publish the consumable jobs row. */
export function enqueueEditWriteback(input: Omit<EnqueueInput, "id" | "action" | "book_id"> & EditWritebackOptions & { book_id: string }, library = getLibrary()) {
  const id = newBookId();
  try {
    stageEditWriteback(library, id, input);
    const result = enqueueJob({ id, book_id: input.book_id, rule_template: input.rule_template, action: "edit-writeback" }, library);
    if (!result.queued) rmSync(queueDirectory(library, id), { recursive: true, force: true });
    return result;
  } catch (error) { rmSync(queueDirectory(library, id), { recursive: true, force: true }); throw error; }
}
export function queueCapacity(): number {
  const raw = (readEnv("BINDERY_INGEST_QUEUE_MAXSIZE") || "").trim();
  if (!/^[+-]?\d+$/.test(raw)) return 64;
  return Math.max(1, Math.min(2048, Number(raw)));
}

/** Durable submission only. Slice C owns claiming, processing and recovery. */
export function enqueueJob(input: EnqueueInput, library = getLibrary()): { queued: boolean; job: Job } {
  if (isRuntimeShuttingDown()) throw new HttpError(503, "服务正在关闭，请稍后重试");
  const action = input.action || "regenerate";
  if (!["regenerate", "retry", "edit-writeback", "upload", "upload-epub", "ingest"].includes(action) ||
      input.book_id !== null && !/^[a-f0-9]{32}$/.test(input.book_id) ||
      input.id !== undefined && !/^[a-f0-9]{32}$/.test(input.id) ||
      input.book_id === null && ["regenerate", "retry", "edit-writeback"].includes(action)) {
    throw new HttpError(400, "任务参数错误");
  }
  if (action === "edit-writeback") {
    if (!input.id) return enqueueEditWriteback({ book_id: input.book_id!, rule_template: input.rule_template, cover_bytes: null, cover_name: null, cover_url: "", strip_original_css: false, strip_fonts: false }, library);
    loadEditWriteback(library, input.id);
  }
  library.ensure();
  const now = nowIso();
  return library.db.withConnection(conn => {
    // Serialize capacity check and insertion across processes/worktrees.
    conn.exec("BEGIN IMMEDIATE");
    try {
      const waiting = conn.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'running' AND stage = '排队中'").get()!.n as number;
      const queued = waiting < queueCapacity();
      const job: Job = {
        id: input.id ?? newBookId(), book_id: input.book_id, action,
        status: queued ? "running" : "failed", stage: queued ? "排队中" : "失败",
        message: queued ? "等待后台处理" : "任务队列已满，请稍后重试", log: null,
        rule_template: input.rule_template ?? null, created_at: now, updated_at: now,
      };
      conn.prepare("INSERT INTO jobs(id, book_id, action, status, stage, message, log, rule_template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(job.id, job.book_id, job.action, job.status, job.stage, job.message, job.log, job.rule_template, job.created_at, job.updated_at);
      conn.exec("COMMIT");
      return { queued, job };
    } catch (error) {
      conn.exec("ROLLBACK");
      throw error;
    }
  });
}
