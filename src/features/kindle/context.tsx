import { createContext, createSignal, onSettled, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { KindleDeviceManager, deviceInventory, errorMessage, getTransferQueue, type DeviceInventory, type DeviceState, type RememberedDevice, type TransferItem, type TransferQueue } from "../../client/kindle";

// One inert manager per runtime. SSR never calls its browser / File System Access APIs.
let shared: KindleDeviceManager | null = null;
export function kindleManager(): KindleDeviceManager {
  return (shared ??= new KindleDeviceManager());
}

const neutral = (): DeviceState => ({ status: "unpaired", device: null, checkedAt: null, now: 0, message: "" });

function createKindleContext(manager: KindleDeviceManager, queue: () => TransferQueue) {
  const [ready, setReady] = createSignal(false), [supported, setSupported] = createSignal(false);
  const [state, setState] = createSignal<DeviceState>(neutral());
  const [inventory, setInventory] = createSignal<DeviceInventory | null>(null);
  const [inventoryBusy, setInventoryBusy] = createSignal(false), [inventoryError, setInventoryError] = createSignal("");
  const [remembered, setRemembered] = createSignal<RememberedDevice[]>([]);
  const [permissions, setPermissions] = createSignal<Record<string, PermissionState>>({});
  const [items, setItems] = createSignal<readonly TransferItem[]>([]);
  const [error, setError] = createSignal(""), [busy, setBusy] = createSignal(false);
  let alive = true, revision = 0, observed = neutral();
  async function loadRemembered() {
    const saved = await manager.remembered();
    const statuses = await Promise.all(saved.map(async d => [d.id, await d.root.queryPermission({ mode: "readwrite" })] as const));
    if (alive) { setRemembered(saved); setPermissions(Object.fromEntries(statuses)); }
    return saved;
  }
  async function refreshInventory() {
    // Solid 2 reads in this turn may still see the preceding render snapshot.
    // The manager is authoritative for imperative work immediately after subscribe/setState.
    const current = manager.snapshot(), token = ++revision, device = current.status === "granted" ? current.device : null;
    if (!device) { setInventory(null); setInventoryBusy(false); return; }
    setInventoryBusy(true); setInventoryError("");
    try { const result = await deviceInventory(device); if (alive && token === revision) setInventory(result); }
    catch (e) { if (alive && token === revision) { setInventory(null); setInventoryError(errorMessage(e)); await manager.probe(); } }
    finally { if (alive && token === revision) setInventoryBusy(false); }
  }
  async function run(action: () => Promise<unknown>) {
    setError(""); setBusy(true);
    try { await action(); }
    catch (e) { if (alive && !(e instanceof Error && e.name === "AbortError")) setError(errorMessage(e)); }
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
      if (alive && manager.snapshot().checkedAt === null && !manager.snapshot().device && saved.length) await manager.restore(saved[0]!);
    });
    const stop = manager.startMonitoring(); setReady(true);
    return () => { alive = false; revision++; stop(); unsubscribe(); unsubscribeQueue(); };
  }
  return {
    manager, ready, supported, state, inventory, inventoryBusy, inventoryError, remembered, permissions, items, error, busy,
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
    enqueue: (bookId: string, profileId = "default", overwrite = false) => {
      const current = manager.snapshot();
      if (current.status !== "granted" || !current.device || current.device.identity.id !== state().device?.identity.id) throw new Error("设备已切换或断开，请重新选择书籍");
      return queue().enqueue(current.device, bookId, profileId, { overwrite });
    },
    cancel: (id: string) => queue().cancel(id), clearFinished: () => queue().clearFinished(),
  };
}
export type KindleContextValue = ReturnType<typeof createKindleContext>;
const KindleContext = createContext<KindleContextValue | null>(null);
/** Shared across Kindle tabs; navigating never cancels the SPA queue. */
export function KindleProvider(props: { children: JSX.Element; manager?: KindleDeviceManager; queue?: TransferQueue }) {
  const value = createKindleContext(props.manager ?? kindleManager(), () => props.queue ?? getTransferQueue());
  onSettled(() => value.start());
  return <KindleContext value={value}>{props.children}</KindleContext>;
}
export function useKindle() {
  const context = useOptionalKindle();
  if (!context) throw new Error("Kindle 页面必须位于 KindleProvider 内");
  return context;
}
export function useOptionalKindle() { return useContext(KindleContext); }
/** Inert manager is available during SSR. Render device state through useKindle().state/ready. */
export function useKindleManager(): KindleDeviceManager | null { return useOptionalKindle()?.manager ?? null; }
