export type TransferState = "等待" | "转换" | "写入" | "完成" | "失败";
export type TransferPhase = "download" | "convert" | "write" | "thumbnail" | "finalize";
export interface TransferProgress {
  state: TransferState;
  message: string;
  phase: TransferPhase;
  loaded?: number;
  total?: number;
  startedAt: number;
  phaseStartedAt: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
}
type Update = Omit<TransferProgress, "startedAt" | "phaseStartedAt" | "bytesPerSecond">;
export const PROGRESS_INTERVAL_MS = 100;
/** Byte/timer updates are capped at 10 Hz. Phase boundaries and the final byte flush immediately. */
export class TransferProgressReporter {
  readonly startedAt = Date.now();
  private phase?: TransferPhase;
  private state?: TransferState;
  private phaseStartedAt = this.startedAt;
  private emittedAt = -Infinity;
  constructor(private receive?: (progress: TransferProgress) => void) {}
  report(update: Update, flush = false) {
    const now = Date.now(), changed = update.phase !== this.phase || update.state !== this.state;
    if (update.phase !== this.phase) this.phaseStartedAt = now;
    this.phase = update.phase; this.state = update.state;
    if (!changed && !flush && now - this.emittedAt < PROGRESS_INTERVAL_MS) return;
    this.emittedAt = now;
    const elapsed = (now - this.phaseStartedAt) / 1000;
    const bytesPerSecond = update.loaded !== undefined && update.loaded > 0 && elapsed > 0 ? update.loaded / elapsed : undefined;
    const etaSeconds = bytesPerSecond && update.total !== undefined ? Math.max(0, (update.total - update.loaded!) / bytesPerSecond) : update.etaSeconds;
    this.receive?.({ ...update, loaded: update.loaded, total: update.total, startedAt: this.startedAt, phaseStartedAt: this.phaseStartedAt, bytesPerSecond, etaSeconds });
  }
}
