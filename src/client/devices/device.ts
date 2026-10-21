import { createSignal, onCleanup } from "solid-js";
import { assertReachable, errorMessage, type DeviceDirectory } from "./fs";
import { detectDevice, pairDetectedDevice, readFirmware, readIdentity, type DeviceDetection, type PairedDevice } from "./identity";
import { IndexedDbHandles, type HandleRepository, type RememberedDevice } from "./remembered";
import { withDeviceLock } from "./transaction";
import type { DeviceKind } from "./models";

export type DevicePermission = "granted" | "prompt" | "denied" | "disconnected" | "unpaired";
export interface DeviceState { status: DevicePermission; device: PairedDevice | null; detected: DeviceDetection | null; checkedAt: number | null; now: number; message: string }
export const detectedAgo = (state: Pick<DeviceState, "checkedAt" | "now">) => state.checkedAt === null ? "尚未检测" : `检测于 ${Math.max(0, Math.floor((state.now - state.checkedAt) / 1000))} 秒前`;
export type DirectoryPicker = (options: { mode: "readwrite" }) => Promise<DeviceDirectory>;
export class DeviceManager {
  private state: DeviceState = { status: "unpaired", device: null, detected: null, checkedAt: null, now: Date.now(), message: "" };
  private root: DeviceDirectory | null = null;
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
  private kind(): DeviceKind { return this.state.device?.identity.kind ?? this.state.detected?.kind ?? "kindle"; }
  async forget(id: string) {
    await this.handles.remove(id);
    if (this.expectedId === id || this.state.device?.identity.id === id) {
      this.generation++; this.root = null; this.expectedId = null;
      this.update({ status: "unpaired", device: null, detected: null, checkedAt: null, message: "" });
    }
  }
  async pick() {
    const picker = this.picker ?? (globalThis as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
    if (!picker) throw new Error("此浏览器不支持设备磁盘访问，请使用 Windows 上的 Edge 或 Chrome");
    const root = await picker({ mode: "readwrite" });
    const detection = await detectDevice(root);
    this.generation++; this.root = root; this.expectedId = null;
    this.update({ detected: detection, device: null, status: "unpaired", checkedAt: null, message: "" });
    await this.probe();
    return this.state;
  }
  async restore(remembered: RememberedDevice | string) {
    const saved = typeof remembered === "string" ? (await this.remembered()).find(d => d.id === remembered) : remembered;
    if (!saved) throw new Error("未找到已配对设备");
    this.generation++; this.root = saved.root; this.expectedId = saved.id;
    this.update({ device: { root: saved.root, identity: saved.identity, firmware: null }, detected: { kind: saved.identity.kind, model: saved.identity.model, productId: saved.identity.product_id ?? null, firmware: null }, checkedAt: null });
    await this.probe();
  }
  async pair(model: string, name: string) {
    if (!this.root) throw new Error("请先选择设备磁盘根目录");
    const root = this.root, generation = this.generation;
    const detection = this.state.detected ?? await detectDevice(root);
    const device = await pairDetectedDevice(root, detection, model, name);
    await this.handles.put({ id: device.identity.id, identity: device.identity, root: device.root });
    if (generation !== this.generation) return device;
    this.expectedId = device.identity.id;
    this.update({ status: "granted", device, detected: { kind: device.identity.kind, model: device.identity.model, productId: device.identity.product_id ?? detection.productId, firmware: device.firmware }, checkedAt: Date.now(), message: "" });
    return device;
  }
  /** Call directly from a click handler: Chrome requires transient user activation. */
  async requestPermission() {
    if (!this.root) throw new Error("请先选择设备磁盘根目录");
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
      let identified = this.state.device?.root === root ? this.state.device : null;
      let kind = this.state.device?.identity.kind ?? this.state.detected?.kind ?? "kindle";
      try {
        const status = await root.queryPermission({ mode: "readwrite" });
        if (status !== "granted") { update({ status, message: "请点击授权以访问设备" }); return; }
        if (!this.state.detected) {
          try { const detected = await detectDevice(root); kind = detected.kind; update({ detected }); }
          catch { /* A paired device identity below is authoritative if detection is temporarily incomplete. */ }
        }
        await assertReachable(root, kind);
        const identity = await readIdentity(root, kind);
        if (!identity) { update({ status: "unpaired", device: null, checkedAt: Date.now(), message: this.state.detected?.kind === "kobo" ? "请设置名称以完成 Kobo 配对" : "请设置 Kindle 型号和名称以完成配对" }); return; }
        if (this.expectedId && this.expectedId !== identity.id) { const error = new Error("设备身份已改变，请重新选择设备"); error.name = "DeviceIdentityError"; throw error; }
        const device = { root, identity, firmware: await readFirmware(root, identity.kind) };
        identified = device;
        // Recovery shares the mutation lock; a probe must never roll back a live transfer.
        await withDeviceLock(device, async () => {});
        if (generation !== this.generation) return;
        await this.handles.put({ id: identity.id, root, identity });
        update({ status: "granted", device, checkedAt: Date.now(), message: "" });
      } catch (error) {
        try {
          await assertReachable(root, kind);
          const changed = error instanceof Error && error.name === "DeviceIdentityError";
          update({ status: changed ? "unpaired" : identified ? "granted" : "unpaired", device: changed ? null : identified, checkedAt: Date.now(), message: errorMessage(error, kind) });
        } catch (rootError) {
          update({ status: rootError instanceof Error && ["NotAllowedError", "SecurityError"].includes(rootError.name) ? "denied" : "disconnected", message: errorMessage(rootError, kind) });
        }
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
export function useDevice(manager: DeviceManager) {
  const [state, setState] = createSignal(manager.snapshot());
  onCleanup(manager.subscribe(setState));
  return state;
}
export const useKindleDevice = useDevice;
