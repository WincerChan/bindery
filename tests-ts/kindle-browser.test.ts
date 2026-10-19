import { build } from "vite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IndexedDbHandles, type RememberedDevice } from "../src/client/kindle/remembered";
import { pairDevice } from "../src/client/kindle/identity";
import { fakeKindle } from "./support/fake-fs";
import { makeThumbnail, THUMBNAIL_SIZE } from "../src/client/kindle/thumbnail";

/** Minimal transaction fake: requests finish before commit, and abort must reject put(). */
function fakeIndexedDb() {
  const records = new Map<string, RememberedDevice>(); let initialized = false, abortNext = false, closed = 0;
  const db = {
    createObjectStore(name: string, options: unknown) { expect(name).toBe("devices"); expect(options).toEqual({ keyPath: "id" }); },
    close() { closed++; },
    transaction(name: string, mode: string) {
      expect(name).toBe("devices"); expect(["readonly", "readwrite"]).toContain(mode);
      const tx = { oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, onerror: null, error: null as DOMException | null,
        objectStore() {
          const operation = <T>(fn: () => T) => {
            const request = { result: undefined as T | undefined, error: null };
            setTimeout(() => {
              if (abortNext) { abortNext = false; tx.error = new DOMException("disk error", "AbortError"); tx.onabort?.(); }
              else { request.result = fn(); setTimeout(() => tx.oncomplete?.(), 0); }
            }, 0); return request;
          };
          return { getAll: () => operation(() => [...records.values()]), put: (value: RememberedDevice) => operation(() => { records.set(value.id, value); return value.id; }), delete: (id: string) => operation(() => { records.delete(id); }) };
        },
      }; return tx;
    },
  };
  const factory = { open(name: string, version: number) {
    expect(name).toBe("bindery-kindle"); expect(version).toBe(1);
    const request = { result: db, onupgradeneeded: null as (() => void) | null, onsuccess: null as (() => void) | null, onerror: null, onblocked: null };
    setTimeout(() => { if (!initialized) { initialized = true; request.onupgradeneeded?.(); } request.onsuccess?.(); }, 0); return request;
  } } as unknown as IDBFactory;
  return { factory, abort: () => { abortNext = true; }, closed: () => closed };
}
describe("browser packaging and handle persistence", () => {
  it("fits a portrait cover into 330×470 without distortion, writes JPEG and releases the bitmap", async () => {
    const ctx = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }, canvas = { width: 0, height: 0, getContext: () => ctx, toBlob: (receive: (blob: Blob) => void, format: string, quality: number) => { expect(format).toBe("image/jpeg"); expect(quality).toBe(0.85); receive(new Blob([new Uint8Array([255, 216, 255, 217])])); } }, bitmap = { width: 1000, height: 1600, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", async () => bitmap); vi.stubGlobal("document", { createElement: () => canvas });
    try {
      expect(await makeThumbnail(new Uint8Array([1]))).toEqual(new Uint8Array([255, 216, 255, 217])); expect({ width: canvas.width, height: canvas.height }).toEqual(THUMBNAIL_SIZE); expect(ctx.fillStyle).toBe("white"); expect(ctx.drawImage).toHaveBeenCalledWith(bitmap, 18, 0, 294, 470); expect(bitmap.close).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
  it("persists multiple handle identities through transactions and surfaces storage aborts", async () => {
    const fake = fakeIndexedDb(), repository = new IndexedDbHandles(fake.factory), first = await fakeKindle(), second = await fakeKindle();
    const a = await pairDevice(first.root, "KPW3", "A"), b = await pairDevice(second.root, "KO3", "B");
    await repository.put({ id: a.identity.id, root: a.root, identity: a.identity }); await repository.put({ id: b.identity.id, root: b.root, identity: b.identity });
    const restored = await repository.list(); expect(restored.map(d => d.id)).toEqual([a.identity.id, b.identity.id]); expect(restored[0].root).toBe(first.root);
    first.unplug(); await expect(restored[0].root.getDirectoryHandle("documents")).rejects.toMatchObject({ name: "NotFoundError" }); first.plug(); await expect(restored[0].root.getDirectoryHandle("documents")).resolves.toBeDefined();
    await repository.remove(a.identity.id); expect(await repository.list()).toHaveLength(1);
    fake.abort(); await expect(repository.put({ id: a.identity.id, root: a.root, identity: a.identity })).rejects.toMatchObject({ name: "AbortError" }); expect(fake.closed()).toBe(6);
  });
  it("builds a browser Worker with a distinct cacheable WASM asset and no server/Node modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "bindery-kindle-worker-"));
    try {
      await build({ configFile: false, logLevel: "silent", build: { outDir: root, minify: false, rollupOptions: { input: resolve("src/client/boko/client.ts"), preserveEntrySignatures: "strict", output: { entryFileNames: "client.js" } } } });
      const files = readdirSync(join(root, "assets")), wasm = files.find(name => name.endsWith(".wasm")), worker = files.find(name => name.startsWith("worker-") && name.endsWith(".js"));
      expect(wasm).toBeDefined(); expect(worker).toBeDefined();
      expect(readFileSync(join(root, "assets", wasm!))).toEqual(readFileSync("vendor/boko/boko_bg.wasm"));
      const code = readFileSync(join(root, "assets", worker!), "utf8"); expect(code).toContain(wasm); expect(code).not.toContain("node:"); expect(code).not.toContain("/server/");
      expect(readFileSync(join(root, "client.js"), "utf8")).toContain(worker);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
