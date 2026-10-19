import { createSignal, onCleanup } from "solid-js";
import { errorMessage, type KindleDirectory } from "./fs";
import { pairDevice, readFirmware, readIdentity, validateKindle, type KindleModel, type PairedDevice } from "./identity";
import { IndexedDbHandles, type HandleRepository, type RememberedDevice } from "./remembered";
import { withDeviceLock } from "./transaction";

export type DevicePermission = "granted" | "prompt" | "denied" | "disconnected" | "unpaired";
export interface DeviceState { status: DevicePermission; device: PairedDevice | null; checkedAt: number | null; now: number; message: string }
export const detectedAgo = (state: Pick<DeviceState, "checkedAt" | "now">) => state.checkedAt === null ? "尚未检测" : `检测于 ${Math.max(0, Math.floor((state.now - state.checkedAt) / 1000))} 秒前`;
export type DirectoryPicker = (options: { mode: "readwrite" }) => Promise<KindleDirectory>;
export class KindleDeviceManager {
  private state: DeviceState = { status: "unpaired", device: null, checkedAt: null, now: Date.now(), message: "" };
  private root: KindleDirectory | null = null;
  private expectedId: string | null = null;
  private listeners = new Set<(state: DeviceState) => void>();
  private generation = 0;
  private probeGeneration = -1;
  private probing: Promise<void> | null = null;
  constructor(private handles: HandleRepository = new IndexedDbHandles(), private picker?: DirectoryPicker) {}
  snapshot = () => this.state;
  subscribe = (listener: (state: DeviceState) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<DeviceState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.state); }
  remembered() { return this.handles.list(); }
  async forget(id: string) {
    await this.handles.remove(id);
    if (this.expectedId === id || this.state.device?.identity.id === id) {
      this.generation++; this.root = null; this.expectedId = null;
      this.update({ status: "unpaired", device: null, checkedAt: null, message: "" });
    }
  }
  async pick() {
    const picker = this.picker ?? (globalThis as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
    if (!picker) throw new Error("此浏览器不支持 Kindle 磁盘访问，请使用 Windows 上的 Edge 或 Chrome");
    const root = await picker({ mode: "readwrite" });
    await validateKindle(root);
    this.generation++; this.root = root; this.expectedId = null;
    await this.probe();
    return this.state;
  }
  async restore(remembered: RememberedDevice | string) {
    const saved = typeof remembered === "string" ? (await this.remembered()).find(d => d.id === remembered) : remembered;
    if (!saved) throw new Error("未找到已配对的 Kindle");
    this.generation++; this.root = saved.root; this.expectedId = saved.id;
    this.update({ device: { root: saved.root, identity: saved.identity, firmware: null }, checkedAt: null });
    await this.probe();
  }
  async pair(model: KindleModel, name: string) {
    if (!this.root) throw new Error("请先选择 Kindle 磁盘根目录");
    const root = this.root, generation = this.generation;
    const device = await pairDevice(root, model, name);
    await this.handles.put({ id: device.identity.id, identity: device.identity, root: device.root });
    if (generation !== this.generation) return device;
    this.expectedId = device.identity.id;
    this.update({ status: "granted", device, checkedAt: Date.now(), message: "" });
    return device;
  }
  /** Call directly from a click handler: Chrome requires transient user activation. */
  async requestPermission() {
    if (!this.root) throw new Error("请先选择 Kindle 磁盘根目录");
    const generation = this.generation;
    const result = await this.root.requestPermission({ mode: "readwrite" });
    if (generation !== this.generation) return this.state.status;
    this.update({ status: result });
    if (result === "granted") await this.probe();
    return this.state.status;
  }
  async probe(): Promise<void> {
    // A changed selection must not be swallowed by the previous handle's pending probe.
    if (this.probing) {
      if (this.probeGeneration === this.generation) return this.probing;
      await this.probing; return this.probe();
    }
    const root = this.root, generation = this.generation;
    if (!root) return;
    this.probeGeneration = generation;
    this.probing = (async () => {
      const update = (patch: Partial<DeviceState>) => { if (generation === this.generation) this.update({ now: Date.now(), ...patch }); };
      try {
        const status = await root.queryPermission({ mode: "readwrite" });
        if (status !== "granted") { update({ status, message: "请点击授权以访问 Kindle" }); return; }
        await root.getDirectoryHandle("documents");
        const identity = await readIdentity(root);
        if (!identity) { update({ status: "unpaired", device: null, checkedAt: Date.now(), message: "请设置 Kindle 型号和名称以完成配对" }); return; }
        if (this.expectedId && this.expectedId !== identity.id) throw new Error("Kindle 身份已改变，请重新选择设备");
        const device = { root, identity, firmware: await readFirmware(root) };
        // Recovery shares the mutation lock; a probe must never roll back a live transfer.
        await withDeviceLock(device, async () => {});
        if (generation !== this.generation) return;
        await this.handles.put({ id: identity.id, root, identity });
        update({ status: "granted", device, checkedAt: Date.now(), message: "" });
      } catch (error) {
        update({ status: error instanceof Error && error.name === "NotAllowedError" ? "denied" : "disconnected", message: errorMessage(error) });
      }
    })();
    try { await this.probing; } finally { this.probing = null; }
  }
  /** Owned by the SPA shell, not an individual page. No plug/unplug browser events exist. */
  startMonitoring(target: Window = window, page: Document = document): () => void {
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer); timer = undefined;
      if (page.visibilityState !== "hidden") {
        void this.probe();
        timer = setInterval(() => { this.update({ now: Date.now() }); void this.probe(); }, 1500);
      }
    };
    const focus = () => { if (page.visibilityState !== "hidden") void this.probe(); };
    target.addEventListener("focus", focus); page.addEventListener("visibilitychange", sync); sync();
    return () => { clearInterval(timer); target.removeEventListener("focus", focus); page.removeEventListener("visibilitychange", sync); };
  }
}
/** Bind an existing long-lived manager into a component's Solid owner. */
export function useKindleDevice(manager: KindleDeviceManager) {
  const [state, setState] = createSignal(manager.snapshot());
  onCleanup(manager.subscribe(setState));
  return state;
}
