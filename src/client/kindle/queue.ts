import { createSignal, onCleanup } from "solid-js";
import { errorMessage } from "./fs";
import type { PairedDevice } from "./identity";
import { getTransferService, type KindleTransferService, type TransferOptions, type TransferState } from "./transfer";

export interface TransferItem { id: string; deviceId: string; bookId: string; profileId: string; state: TransferState; message: string; filename?: string }
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
    this.items = [...this.items, { id, deviceId: device.identity.id, bookId, profileId, state: "等待", message: "等待传输" }];
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
        this.update(current.id, { state: "转换", message: "准备转换" });
        try {
          const record = await this.service.transferBook(job.device, current.bookId, current.profileId, { ...job.options, signal: job.controller.signal, progress: (state, message) => this.update(current.id, { state, message }) });
          this.update(current.id, { state: "完成", message: "已传入 Kindle", filename: record.filename });
        } catch (error) { this.update(current.id, { state: "失败", message: errorMessage(error) }); }
        finally { this.jobs.delete(current.id); }
      }
    } finally { this.running = false; }
  }
}
let shared: TransferQueue | undefined;
export const getTransferQueue = () => shared ??= new TransferQueue();
export function useTransferQueue(queue = getTransferQueue()) { const [items, setItems] = createSignal(queue.snapshot()); onCleanup(queue.subscribe(setItems)); return items; }
