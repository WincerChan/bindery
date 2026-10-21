import type { DeviceIdentity } from "./identity";
import type { DeviceDirectory } from "./fs";

export interface RememberedDevice { id: string; identity: DeviceIdentity; root: DeviceDirectory }
export interface HandleRepository {
  list(): Promise<RememberedDevice[]>;
  put(device: RememberedDevice): Promise<void>;
  remove(id: string): Promise<void>;
}
/** Only handles/identity live here. Library data and EPUB/KEPUB bytes never enter IndexedDB. */
export class IndexedDbHandles implements HandleRepository {
  constructor(private factory?: IDBFactory) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const factory = this.factory ?? globalThis.indexedDB;
      if (!factory) { reject(new Error("此浏览器无法保存设备磁盘授权记录")); return; }
      let blocked = false;
      // Keep the old database name so devices paired before the generic layer survive upgrades.
      const request = factory.open("bindery-kindle", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("devices", { keyPath: "id" });
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(new Error("设备记录数据库被其他页面占用，请关闭旧页面后重试")); };
    });
  }
  private async run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("devices", mode), request = action(tx.objectStore("devices"));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error ?? request.error ?? new Error("设备记录保存失败"));
        tx.onerror = () => { /* onabort is the transaction boundary. */ };
      });
    } finally { db.close(); }
  }
  list() { return this.run<RememberedDevice[]>("readonly", store => store.getAll()); }
  async put(device: RememberedDevice) { await this.run("readwrite", store => store.put(device)); }
  async remove(id: string) { await this.run("readwrite", store => store.delete(id)); }
}
