import { createSignal, onCleanup } from "solid-js";
import { errorMessage } from "./fs";
import type { PairedDevice } from "./identity";
import type { ProfileSettings } from "./profiles";
import type { DeviceKind } from "./models";
import type { TransferProgress } from "./progress";
import { getDeviceTransferService } from "./transfer";

export interface TransferOptions { overwrite?: boolean; settings?: ProfileSettings; profileName?: string; signal?: AbortSignal; progress?: (progress: TransferProgress) => void }
/** What a queued request remembers; retry replays exactly these. */
export type TransferRequestOptions = Pick<TransferOptions, "overwrite" | "settings" | "profileName">;
export interface TransferResult { filename: string; size: number }
export interface TransferService { transferBook(device: PairedDevice, bookId: string, profileId: string, options: TransferOptions): Promise<TransferResult> }

export interface TransferItem extends TransferProgress {
  id: string; deviceId: string; bookId: string; profileId: string; kind?: DeviceKind; filename?: string;
  /** EPUB bytes, kept independently of the current phase and converter output size. */
  downloadedBytes: number; downloadTotal?: number;
  /** Converted device bytes only. Retained across finalize; rolled-back failures contribute zero to the batch. */
  writtenBytes: number; writeTotal?: number;
}
const successMessage = (kind: DeviceKind | undefined) => kind === "kobo" ? "已传入 Kobo" : "已传入 Kindle";
/** SPA-lifetime queue; no component owner or navigation cleanup cancels an active transfer. */
export class TransferQueue {
  private items: TransferItem[] = [];
  private jobs = new Map<string, { device: PairedDevice; controller: AbortController; options: TransferRequestOptions }>();
  /** Request options outlive the job so a failed item can be retried with the same settings. */
  private requests = new Map<string, TransferRequestOptions>();
  private listeners = new Set<(items: readonly TransferItem[]) => void>();
  private running = false;
  constructor(private service: Pick<TransferService, "transferBook">) {}
  snapshot = (): readonly TransferItem[] => this.items;
  subscribe = (listener: (items: readonly TransferItem[]) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(id: string, patch: Partial<TransferItem>) { this.items = this.items.map(i => i.id === id ? { ...i, ...patch } : i); for (const listener of this.listeners) listener(this.items); }
  enqueue(device: PairedDevice, bookId: string, profileId = "default", options: TransferRequestOptions = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.items = [...this.items, { id, deviceId: device.identity.id, bookId, profileId, kind: device.identity.kind, state: "等待", message: "等待传输", phase: "download", startedAt: now, phaseStartedAt: now, downloadedBytes: 0, writtenBytes: 0 }];
    this.jobs.set(id, { device, controller: new AbortController(), options }); this.requests.set(id, options);
    for (const listener of this.listeners) listener(this.items);
    void this.drain(); return id;
  }
  cancel(id: string) { this.jobs.get(id)?.controller.abort(); if (this.items.find(i => i.id === id)?.state === "等待") { this.update(id, { state: "失败", message: "操作已取消" }); this.jobs.delete(id); } }
  clearFinished() { this.items = this.items.filter(i => this.jobs.has(i.id)); this.forgetRequests(); for (const listener of this.listeners) listener(this.items); }
  /** Replaces a failed item with a new one for the same book, device and options. */
  retry(id: string, device: PairedDevice) {
    const item = this.items.find(i => i.id === id);
    if (!item || item.state !== "失败") return undefined;
    if (device.identity.id !== item.deviceId) throw new Error("请先连接这本书的目标设备");
    const options = this.requests.get(id) ?? {};
    this.items = this.items.filter(i => i.id !== id); this.requests.delete(id);
    return this.enqueue(device, item.bookId, item.profileId, options);
  }
  private forgetRequests() { const live = new Set(this.items.map(i => i.id)); for (const id of this.requests.keys()) if (!live.has(id)) this.requests.delete(id); }
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
          this.update(current.id, { state: "完成", phase: "finalize", message: successMessage(current.kind), filename: record.filename, writtenBytes: record.size, writeTotal: record.size, bytesPerSecond: undefined, etaSeconds: undefined });
        } catch (error) { this.update(current.id, { state: "失败", message: errorMessage(error, current.kind ?? "kindle"), writtenBytes: 0, bytesPerSecond: undefined, etaSeconds: undefined }); }
        finally { this.jobs.delete(current.id); }
      }
    } finally { this.running = false; }
  }
}
let shared: TransferQueue | undefined;
export const getTransferQueue = () => shared ??= new TransferQueue(getDeviceTransferService());
export function useTransferQueue(queue = getTransferQueue()) { const [items, setItems] = createSignal(queue.snapshot()); onCleanup(queue.subscribe(setItems)); return items; }

