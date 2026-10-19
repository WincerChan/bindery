import { createSignal, onCleanup } from "solid-js";
import { errorMessage } from "./fs";
import type { PairedDevice } from "./identity";
import { getTransferService, type KindleTransferService, type TransferOptions, type TransferProgress } from "./transfer";

export interface TransferItem extends TransferProgress {
  id: string; deviceId: string; bookId: string; profileId: string; filename?: string;
  /** EPUB bytes, kept independently of the current phase and KFX output size. */
  downloadedBytes: number; downloadTotal?: number;
  /** KFX bytes only. Retained across finalize; rolled-back failures contribute zero to the batch. */
  writtenBytes: number; writeTotal?: number;
}
/** SPA-lifetime queue; no component owner or navigation cleanup cancels an active transfer. */
export class TransferQueue {
  private items: TransferItem[] = [];
  private jobs = new Map<string, { device: PairedDevice; controller: AbortController; options: Pick<TransferOptions, "overwrite"> }>();
  private listeners = new Set<(items: readonly TransferItem[]) => void>();
  private running = false;
  constructor(private service: Pick<KindleTransferService, "transferBook"> = getTransferService()) {}
  snapshot = (): readonly TransferItem[] => this.items;
  subscribe = (listener: (items: readonly TransferItem[]) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(id: string, patch: Partial<TransferItem>) { this.items = this.items.map(i => i.id === id ? { ...i, ...patch } : i); for (const listener of this.listeners) listener(this.items); }
  enqueue(device: PairedDevice, bookId: string, profileId = "default", options: Pick<TransferOptions, "overwrite"> = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.items = [...this.items, { id, deviceId: device.identity.id, bookId, profileId, state: "等待", message: "等待传输", phase: "download", startedAt: now, phaseStartedAt: now, downloadedBytes: 0, writtenBytes: 0 }];
    this.jobs.set(id, { device, controller: new AbortController(), options });
    for (const listener of this.listeners) listener(this.items);
    void this.drain(); return id;
  }
  cancel(id: string) { this.jobs.get(id)?.controller.abort(); if (this.items.find(i => i.id === id)?.state === "等待") { this.update(id, { state: "失败", message: "操作已取消" }); this.jobs.delete(id); } }
  clearFinished() { this.items = this.items.filter(i => this.jobs.has(i.id)); for (const listener of this.listeners) listener(this.items); }
  private async drain() {
    if (this.running) return; this.running = true;
    try {
      let item: TransferItem | undefined;
      while ((item = this.items.find(i => i.state === "等待"))) {
        const current = item, job = this.jobs.get(current.id)!;
        const now = Date.now();
        this.update(current.id, { state: "转换", message: "准备读取书库 EPUB", startedAt: now, phaseStartedAt: now });
        try {
          const record = await this.service.transferBook(job.device, current.bookId, current.profileId, { ...job.options, signal: job.controller.signal, progress: value => {
            const bytes = value.phase === "download" ? { downloadedBytes: value.loaded ?? 0, downloadTotal: value.total } : value.phase === "write" ? { writtenBytes: value.loaded ?? 0, writeTotal: value.total } : {};
            this.update(current.id, { ...value, ...bytes });
          } });
          this.update(current.id, { state: "完成", phase: "finalize", message: "已传入 Kindle", filename: record.filename, writtenBytes: record.size, writeTotal: record.size, bytesPerSecond: undefined, etaSeconds: undefined });
        } catch (error) { this.update(current.id, { state: "失败", message: errorMessage(error), writtenBytes: 0, bytesPerSecond: undefined, etaSeconds: undefined }); }
        finally { this.jobs.delete(current.id); }
      }
    } finally { this.running = false; }
  }
}
let shared: TransferQueue | undefined;
export const getTransferQueue = () => shared ??= new TransferQueue();
export function useTransferQueue(queue = getTransferQueue()) { const [items, setItems] = createSignal(queue.snapshot()); onCleanup(queue.subscribe(setItems)); return items; }
