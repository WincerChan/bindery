/** Persist only the last selected device id; a missing/blocked storage is harmless. */
export interface DevicePreferenceStore {
  get(): string | null;
  set(id: string): void;
  clear(): void;
}

export const LAST_DEVICE_KEY = "bindery.device.last";

export class LocalStorageDevicePreference implements DevicePreferenceStore {
  constructor(private storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">) {}
  private get target() { try { return this.storage ?? globalThis.localStorage ?? null; } catch { return null; } }
  get() { try { return this.target?.getItem(LAST_DEVICE_KEY) || null; } catch { return null; } }
  set(id: string) { try { this.target?.setItem(LAST_DEVICE_KEY, id); } catch { /* Storage can be disabled or full. */ } }
  clear() { try { this.target?.removeItem(LAST_DEVICE_KEY); } catch { /* Storage can be disabled. */ } }
}

export class MemoryDevicePreference implements DevicePreferenceStore {
  constructor(private value: string | null = null) {}
  get() { return this.value; }
  set(id: string) { this.value = id; }
  clear() { this.value = null; }
}
