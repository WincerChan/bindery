import { createContext, createSignal, onSettled, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { DeviceManager, assertReachable, deviceInventory, errorMessage, getTransferQueue, type DeviceInventory, type DeviceState, type RememberedDevice, type TransferItem, type TransferQueue, type TransferRequestOptions } from "../../client/devices";
import type { DeviceKind } from "../../client/devices/models";

// One inert manager per runtime. SSR never calls its browser / File System Access APIs.
let shared: DeviceManager | null = null;
export function deviceManager(): DeviceManager {
  return (shared ??= new DeviceManager());
}
export const kindleManager = deviceManager;

const neutral = (): DeviceState => ({ status: "unpaired", device: null, detected: null, checkedAt: null, now: 0, message: "" });

function createDeviceContext(manager: DeviceManager, queue: () => TransferQueue) {
  const [ready, setReady] = createSignal(false), [supported, setSupported] = createSignal(false);
  const [state, setState] = createSignal<DeviceState>(neutral());
  const [inventory, setInventory] = createSignal<DeviceInventory | null>(null);
  const [inventoryBusy, setInventoryBusy] = createSignal(false), [inventoryError, setInventoryError] = createSignal("");
  const [remembered, setRemembered] = createSignal<RememberedDevice[]>([]);
  const [permissions, setPermissions] = createSignal<Record<string, PermissionState>>({});
  const [connections, setConnections] = createSignal<Record<string, boolean>>({});
  const [items, setItems] = createSignal<readonly TransferItem[]>([]);
  const [error, setError] = createSignal(""), [busy, setBusy] = createSignal(false);
  let alive = true, revision = 0, observed = neutral();
  const kind = (): DeviceKind => state().device?.identity.kind ?? state().detected?.kind ?? "kindle";
  /**
   * Pick the device to restore without ever prompting for permission.
   * - exactly one currently connected device wins;
   * - with several connected devices, the last used one wins (then the first connected);
   * - with none connected, the last used device (then the first remembered) is shown as disconnected.
   */
  async function initialDevice(saved: RememberedDevice[]): Promise<RememberedDevice | null> {
    if (!saved.length) return null;
    const statuses = new Map(await Promise.all(saved.map(async device => [device.id, await device.root.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as PermissionState)] as const)));
    const connectedIds = new Set<string>();
    await Promise.all(saved.filter(device => statuses.get(device.id) === "granted").map(async device => {
      try { await assertReachable(device.root, device.identity.kind); connectedIds.add(device.id); }
      catch { /* Unplugged or temporarily unavailable; do not request permission here. */ }
    }));
    const connected = saved.filter(device => connectedIds.has(device.id)), last = manager.lastUsedId();
    if (connected.length === 1) return connected[0]!;
    if (connected.length > 1) return connected.find(device => device.id === last) ?? connected[0]!;
    return saved.find(device => device.id === last) ?? saved[0]!;
  }
  async function loadRemembered() {
    const saved = await manager.remembered();
    const statuses = await Promise.all(saved.map(async d => [d.id, await d.root.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as PermissionState)] as const));
    const reachable = await Promise.all(saved.map(async d => [d.id, statuses.find(([id]) => id === d.id)?.[1] === "granted" ? await assertReachable(d.root, d.identity.kind).then(() => true, () => false) : false] as const));
    if (alive) { setRemembered(saved); setPermissions(Object.fromEntries(statuses)); setConnections(Object.fromEntries(reachable)); }
    return saved;
  }
  async function refreshInventory() {
    // Solid 2 reads in this turn may still see the preceding render snapshot.
    const current = manager.snapshot(), token = ++revision, device = current.status === "granted" ? current.device : null;
    if (!device) { setInventory(null); setInventoryBusy(false); return; }
    setInventoryBusy(true); setInventoryError("");
    try { const result = await deviceInventory(device); if (alive && token === revision) setInventory(result); }
    catch (e) { if (alive && token === revision) { setInventory(null); setInventoryError(errorMessage(e, device.identity.kind)); await manager.probe(); } }
    finally { if (alive && token === revision) setInventoryBusy(false); }
  }
  async function run(action: () => Promise<unknown>) {
    setError(""); setBusy(true);
    try { await action(); }
    catch (e) { if (alive && !(e instanceof Error && e.name === "AbortError")) setError(errorMessage(e, kind())); }
    finally { if (alive) setBusy(false); }
  }
  function receive(next: DeviceState) {
    const previous = observed; observed = next; setState(next);
    if (previous.status !== next.status || previous.device?.identity.id !== next.device?.identity.id || previous.device?.root !== next.device?.root) { setInventory(null); void refreshInventory(); }
  }
  function start() {
    setSupported(typeof (globalThis as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function");
    const unsubscribe = manager.subscribe(receive);
    const q = queue(); setItems(q.snapshot());
    const unsubscribeQueue = q.subscribe(next => {
      const old = items(); setItems(next);
      if (next.some(item => (item.state === "完成" || item.state === "失败") && old.find(i => i.id === item.id)?.state !== item.state)) void refreshInventory();
    });
    receive(manager.snapshot());
    void run(async () => {
      const saved = await loadRemembered();
      if (!alive || manager.snapshot().checkedAt !== null || manager.snapshot().device) return;
      const selected = await initialDevice(saved);
      if (alive && selected) await manager.restore(selected);
    });
    const stop = manager.startMonitoring(); setReady(true);
    return () => { alive = false; revision++; stop(); unsubscribe(); unsubscribeQueue(); };
  }
  return {
    manager, ready, supported, state, inventory, inventoryBusy, inventoryError, remembered, permissions, connections, items, error, busy, kind,
    start, run, refreshInventory, loadRemembered,
    pick: () => run(async () => { await manager.pick(); await loadRemembered(); }),
    authorize: (saved?: RememberedDevice) => run(async () => {
      // Keep the permission request before any await: Chrome requires user activation.
      if (saved) { await saved.root.requestPermission({ mode: "readwrite" }); await manager.restore(saved); }
      else await manager.requestPermission();
      await loadRemembered();
    }),
    refresh: () => run(async () => { await manager.probe(); await refreshInventory(); await loadRemembered(); }),
    forget: (id: string) => run(async () => { await manager.forget(id); await loadRemembered(); }),
    switchDevice: (id: string) => run(async () => {
      const saved = (await manager.remembered()).find(device => device.id === id);
      if (!saved) throw new Error("未找到已记住的设备");
      await manager.restore(saved);
      await loadRemembered();
    }),
    enqueue: (bookId: string, profileId = "default", options: boolean | TransferRequestOptions = false) => {
      const current = manager.snapshot();
      if (current.status !== "granted" || !current.device || current.device.identity.id !== state().device?.identity.id) throw new Error("设备已切换或断开，请重新选择书籍");
      return queue().enqueue(current.device, bookId, profileId, typeof options === "boolean" ? { overwrite: options } : options);
    },
    retry: (id: string) => run(async () => {
      const current = manager.snapshot();
      if (current.status !== "granted" || !current.device) throw new Error("设备未连接，请重新连接后重试");
      queue().retry(id, current.device);
    }),
    cancel: (id: string) => queue().cancel(id), clearFinished: () => queue().clearFinished(),
  };
}
export type DeviceContextValue = ReturnType<typeof createDeviceContext>;
const DeviceContext = createContext<DeviceContextValue | null>(null);
/** Shared across device tabs; navigating never cancels the SPA queue. */
export function DeviceProvider(props: { children: JSX.Element; manager?: DeviceManager; queue?: TransferQueue }) {
  const value = createDeviceContext(props.manager ?? deviceManager(), () => props.queue ?? getTransferQueue());
  onSettled(() => value.start());
  return <DeviceContext value={value}>{props.children}</DeviceContext>;
}
export function useDevice() {
  const context = useOptionalDevice();
  if (!context) throw new Error("设备页面必须位于 DeviceProvider 内");
  return context;
}
export function useOptionalDevice() { return useContext(DeviceContext); }
/** Inert manager is available during SSR. Render device state through useDevice().state/ready. */
export function useDeviceManager(): DeviceManager | null { return useOptionalDevice()?.manager ?? null; }

// Existing Kindle page tests and imports use these names.
export const KindleProvider = DeviceProvider;
export const useKindle = useDevice;
export const useOptionalKindle = useOptionalDevice;
export const useKindleManager = useDeviceManager;
export type KindleContextValue = DeviceContextValue;
