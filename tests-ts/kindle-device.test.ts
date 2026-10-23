import { describe, expect, it, vi } from "vitest";
import { fakeKindle, FakeFileSystem } from "./support/fake-fs";
import { KindleDeviceManager, detectedAgo } from "../src/client/kindle/device";
import { KINDLE_MODELS, pairDevice, readIdentity, validateKindle } from "../src/client/kindle/identity";
import { inventory } from "../src/client/kindle/inventory";
import { readManifest, writeManifest, parseManifest, thumbnailName } from "../src/client/kindle/manifest";
import { EMPTY_SETTINGS } from "../src/client/devices/profiles";
import { deleteBook } from "../src/client/kindle/operations";
import { deleteFontFamily, installFonts, inspectFont, listFonts, loadPreviewFont, readFont } from "../src/client/kindle/fonts";
import type { HandleRepository, RememberedDevice } from "../src/client/kindle/remembered";
import { applyDevicePatches, recoverDevice, withDeviceLock } from "../src/client/kindle/transaction";

class MemoryHandles implements HandleRepository {
  devices = new Map<string, RememberedDevice>();
  async list() { return [...this.devices.values()]; }
  async put(value: RememberedDevice) { this.devices.set(value.id, value); }
  async remove(id: string) { this.devices.delete(id); }
}
const tick = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
export function fontFile(filename: string, family?: string, style = "Regular") {
  if (!family) return new File([new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], filename);
  const encode = (text: string) => { const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer); for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i)); return bytes; };
  const strings = [encode(family), encode(style)], length = 6 + 24 + strings.reduce((n, v) => n + v.length, 0), bytes = new Uint8Array(28 + length), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, 1); bytes.set(new TextEncoder().encode("name"), 12); view.setUint32(20, 28); view.setUint32(24, length); view.setUint16(30, 2); view.setUint16(32, 30);
  let offset = 0;
  for (let i = 0; i < 2; i++) { const at = 34 + i * 12; view.setUint16(at, 3); view.setUint16(at + 2, 1); view.setUint16(at + 4, 0x409); view.setUint16(at + 6, i ? 17 : 16); view.setUint16(at + 8, strings[i].length); view.setUint16(at + 10, offset); bytes.set(strings[i], 58 + offset); offset += strings[i].length; }
  return new File([bytes], filename);
}
describe("Chrome-like fake file system", () => {
  it("retries the surviving subtree after a per-path recursive removal failure", async () => {
    const fs = await fakeKindle(); await fs.write("documents/book.sdr/first", "remove"); await fs.write("documents/book.sdr/blocked", "keep");
    fs.injectFailure("remove", "documents/book.sdr/blocked", "NotAllowedError");
    const docs = await fs.root.getDirectoryHandle("documents");
    await expect(docs.removeEntry("book.sdr", { recursive: true })).rejects.toMatchObject({ name: "NotAllowedError" });
    const remaining = []; for await (const entry of (await docs.getDirectoryHandle("book.sdr")).values()) remaining.push(entry.name);
    expect(remaining).toEqual(["blocked"]);
    fs.failures.clear(); await docs.removeEntry("book.sdr", { recursive: true });
    await expect(docs.getDirectoryHandle("book.sdr")).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("keeps writes invisible until close, aborts, removes recursively, rejects stale handles", async () => {
    const fs = await fakeKindle(); await fs.write("documents/book.txt", "old");
    const docs = await fs.root.getDirectoryHandle("documents"), file = await docs.getFileHandle("BOOK.TXT"), snapshot = await file.getFile(), writable = await file.createWritable();
    await writable.write("new"); expect(await fs.text("documents/book.txt")).toBe("old"); await writable.abort(); expect(await fs.text("documents/book.txt")).toBe("old");
    const next = await file.createWritable(); await next.write("new"); await next.close(); expect(await snapshot.text()).toBe("old"); expect(await fs.text("documents/book.txt")).toBe("new");
    await fs.write("documents/book.sdr/state", "position"); await expect(docs.removeEntry("book.sdr")).rejects.toMatchObject({ name: "InvalidModificationError" }); await docs.removeEntry("book.sdr", { recursive: true });
    fs.unplug(); await expect(file.getFile()).rejects.toMatchObject({ name: "NotFoundError" }); fs.plug(); expect(await (await file.getFile()).text()).toBe("new");
    await docs.removeEntry("book.txt"); await expect(file.getFile()).rejects.toMatchObject({ name: "NotFoundError" });
  });
});
describe("pairing and persistent identity", () => {
  it("validates root with a Chinese error and models have verified screen dimensions", async () => {
    await expect(validateKindle(new FakeFileSystem().root)).rejects.toThrow("请选择 Kindle 磁盘根目录");
    expect(KINDLE_MODELS.KPW3).toMatchObject({ width: 1072, height: 1448, ppi: 300, inches: 6 }); expect(KINDLE_MODELS.KO3).toMatchObject({ width: 1264, height: 1680, ppi: 300, inches: 7 });
  });
  it("writes once, reads every reconnect, persists multiple devices by ID, and preserves corrupt identity", async () => {
    const fs = await fakeKindle(), repo = new MemoryHandles(), manager = new KindleDeviceManager(repo, async () => fs.root);
    expect((await manager.pick()).status).toBe("unpaired"); const device = await manager.pair("KPW3", "我的 Kindle");
    expect(device.firmware).toBe("Kindle 5.16.2.1.1"); expect(await readIdentity(fs.root)).toEqual(device.identity);
    expect((await pairDevice(fs.root, "KO3", "不能覆盖")).identity).toEqual(device.identity);
    const second = await fakeKindle(), manager2 = new KindleDeviceManager(repo, async () => second.root); await manager2.pick(); await manager2.pair("KO3", "Oasis");
    expect(await manager.remembered()).toHaveLength(2); await manager.forget(manager2.snapshot().device!.identity.id); expect(await manager.remembered()).toHaveLength(1);
    fs.unplug(); await manager.probe(); expect(manager.snapshot().status).toBe("disconnected"); expect(manager.snapshot().message).toContain("已断开");
    fs.plug(); await manager.probe(); expect(manager.snapshot().status).toBe("granted");
    await fs.write(".bindery/device.json", "invalid"); await expect(pairDevice(fs.root, "KO3", "x")).rejects.toThrow(); expect(await fs.text(".bindery/device.json")).toBe("invalid");
  });
  it("restores without automatically prompting and requests readwrite permission only on demand", async () => {
    const fs = await fakeKindle(), paired = await pairDevice(fs.root, "KPW3", "Paperwhite"), repo = new MemoryHandles(); await repo.put({ id: paired.identity.id, identity: paired.identity, root: fs.root });
    fs.permission = "prompt"; fs.operations = []; const manager = new KindleDeviceManager(repo);
    await manager.restore(paired.identity.id); expect(manager.snapshot().status).toBe("prompt"); expect(fs.operations).toEqual([]);
    fs.requestResult = "denied"; expect(await manager.requestPermission()).toBe("denied");
    fs.requestResult = "granted"; expect(await manager.requestPermission()).toBe("granted");
    await fs.write(".bindery/device.json", JSON.stringify({ ...paired.identity, id: "another-device" })); await manager.probe(); expect(manager.snapshot().status).toBe("unpaired"); expect(manager.snapshot().message).toContain("身份已改变");
    await manager.forget(paired.identity.id); await manager.probe(); expect(manager.snapshot().status).toBe("unpaired"); expect(await manager.remembered()).toEqual([]);
  });
  it("probes while visible, pauses while hidden, resumes on focus/visibility and exposes elapsed time", async () => {
    vi.useFakeTimers();
    try {
      const fs = await fakeKindle(), manager = new KindleDeviceManager(new MemoryHandles(), async () => fs.root); await manager.pick(); await manager.pair("KPW3", "Kindle");
      const target = new EventTarget(), page = Object.assign(new EventTarget(), { visibilityState: "visible" }), stop = manager.startMonitoring(target as Window, page as Document);
      await tick(); fs.unplug(); await vi.advanceTimersByTimeAsync(1500); expect(manager.snapshot().status).toBe("disconnected"); expect(detectedAgo(manager.snapshot())).toContain("1 秒前");
      page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange")); const count = fs.operations.length;
      await vi.advanceTimersByTimeAsync(4500); expect(fs.operations.length).toBe(count);
      fs.plug(); target.dispatchEvent(new Event("focus")); await tick(); expect(manager.snapshot().status).toBe("disconnected");
      page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange")); await tick(); expect(manager.snapshot().status).toBe("granted");
      fs.unplug(); target.dispatchEvent(new Event("focus")); await tick(); expect(manager.snapshot().status).toBe("disconnected"); stop(); const after = fs.operations.length; await vi.advanceTimersByTimeAsync(5000); expect(fs.operations.length).toBe(after);
    } finally { vi.useRealTimers(); }
  });
});
describe("inventory, fonts and safe device operations", () => {
  it("round-trips manifest, distinguishes sources/sidecars and reports enumerated usage without capacity", async () => {
    const fs = await fakeKindle(); await pairDevice(fs.root, "KPW3", "Kindle"); await fs.write("documents/Book.kfx", "kfx"); await fs.write("documents/Other.AZW3", "other"); await fs.write("documents/Book.sdr/state", "position"); await fs.write("documents/info.bin", "xx");
    const record = { book_id: "a".repeat(32), filename: "Book.kfx", content_id: "ABC", cde_content_type: "EBOK" as const, profile_id: "default", profile_name: "默认", transferred_at: new Date().toISOString(), size: 3, thumbnail: thumbnailName("ABC", "EBOK") };
    await writeManifest(fs.root, { version: 1, books: [record] }); expect(await readManifest(fs.root)).toEqual({ version: 1, books: [record] });
    for (const name of [".Trashes", ".Spotlight-V100", "System Volume Information", ".Trash-1000", ".active_content_sandbox"]) await fs.write(`${name}/keep`, "untouchable");
    for (const name of ["metadata.calibre", "driveinfo.calibre"]) await fs.write(name, "untouchable");
    await fs.write("fonts/._Font.ttf", "ignored"); await fs.write("fonts/Readme.txt", "readme"); fs.operations = [];
    const result = await inventory(fs.root); expect(result.books.map(b => [b.filename, b.source, b.sidecar])).toEqual([["Book.kfx", "Bindery", "Book.sdr"], ["Other.AZW3", "其他", null]]);
    expect(result.usage.books).toBe(8); expect(result.usage.capacity).toBeNull(); expect(result.usage.free).toBeNull(); expect(result.usage.total).toBe(result.usage.books + result.usage.fonts + result.usage.other);
    expect(fs.operations.filter(o => /calibre|\.Trashes|Spotlight|System Volume|Trash-1000|active_content/.test(o.path) && o.operation !== "iterate")).toEqual([]);
    await deleteBook({ root: fs.root, identity: (await readIdentity(fs.root))!, firmware: null }, "Book.kfx");
    await expect(fs.bytes("documents/Book.kfx")).rejects.toMatchObject({ name: "NotFoundError" }); await expect(fs.bytes("documents/Book.sdr/state")).rejects.toMatchObject({ name: "NotFoundError" }); expect((await readManifest(fs.root)).books).toEqual([]); expect(await fs.text("metadata.calibre")).toBe("untouchable");
    expect(() => parseManifest({ version: 1, books: [{ ...record, filename: "../attack.kfx" }] })).toThrow();
    const settings = { ...EMPTY_SETTINGS, lineHeight: 1.8 };
    expect(parseManifest({ version: 1, books: [record] }).books[0]).not.toHaveProperty("settings");
    expect(parseManifest({ version: 1, books: [{ ...record, settings }] }).books[0]!.settings).toEqual(settings);
    expect(() => parseManifest({ version: 1, books: [{ ...record, settings: { lineHeight: 0.1 } }] })).toThrow();
  });
  it("uses OpenType names before filenames, groups R/B/I/BI and extra weights, and ignores resource files", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    const files = [fontFile("random.ttf", "Book Serif", "Regular"), fontFile("BookSerif-Bold.ttf", "Book Serif", "Bold"), fontFile("BookSerif-Italic.otf", "Book Serif", "Italic"), fontFile("BookSerif-BoldItalic.ttf", "Book Serif", "Bold Italic"), fontFile("BookSerif-Light.ttf", "Book Serif", "Light")];
    await installFonts(device, files); await fs.write("fonts/._random.ttf", "ignored"); await fs.write("fonts/Readme.txt", "keep");
    const families = await listFonts(fs.root); expect(families).toHaveLength(1); expect(families[0].coverage.sort()).toEqual(["B", "BI", "I", "Light", "R"]); expect(families[0].fonts[0].weight).toBe(300);
    expect((await inspectFont(fontFile("Example-SemiBoldItalic.ttf"))).weight).toBe(600);
    await expect(installFonts(device, [files[0]])).rejects.toThrow("已存在"); await expect(installFonts(device, [new File(["invalid"], "bad.ttf")])).rejects.toThrow("无效"); await expect(installFonts(device, [new File(["exe"], "bad.exe")])).rejects.toThrow("只支持");
    expect(await readFont(fs.root, "random.ttf")).toEqual(new Uint8Array(await files[0].arrayBuffer()));
    const faces: unknown[][] = []; vi.stubGlobal("FontFace", class { constructor(...args: unknown[]) { faces.push(args); } load() { return Promise.resolve(this); } });
    try { await loadPreviewFont(device, families[0].fonts[0]); expect(faces[0][0]).toBe("Book Serif"); expect(faces[0][2]).toEqual({ weight: "300", style: "normal" }); } finally { vi.unstubAllGlobals(); }
    await deleteFontFamily(device, "Book Serif"); expect(await listFonts(fs.root)).toEqual([]); expect(await fs.text("fonts/Readme.txt")).toBe("keep"); expect(await fs.text("fonts/._random.ttf")).toBe("ignored");
    await expect(deleteBook(device, "../system/version.txt")).rejects.toThrow(); await expect(readFont(fs.root, "Readme.txt")).rejects.toThrow();
  });
  it("serializes mutations, rejects protected paths and keeps committed book deletion if unplugged during sidecar cleanup", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"); await fs.write("documents/book.kfx", "original"); await fs.write("documents/book.sdr/reading", "position");
    const calls: number[] = []; await Promise.all([withDeviceLock(device, async () => { calls.push(1); await tick(); calls.push(2); }), withDeviceLock(device, async () => { calls.push(3); })]); expect(calls).toEqual([1, 2, 3]);
    await expect(applyDevicePatches(fs.root, [{ path: ["system", "version.txt"], data: null }])).rejects.toThrow("受保护");
    fs.beforeOperation = o => { if (o.operation === "remove" && o.path === "/documents/book.sdr") fs.unplug(); };
    await expect(deleteBook(device, "book.kfx")).rejects.toMatchObject({ name: "NotFoundError" });
    fs.beforeOperation = undefined; fs.plug(); await recoverDevice(fs.root); await expect(fs.text("documents/book.kfx")).rejects.toMatchObject({ name: "NotFoundError" });
    expect((await readManifest(fs.root)).books).toEqual([]);
  });
  it("deletes a book last, without reading or backing it up, and without scanning the device", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    const record = { book_id: "a".repeat(32), filename: "book.kfx", content_id: "ABC", cde_content_type: "EBOK" as const, profile_id: "default", profile_name: "默认", transferred_at: new Date().toISOString(), size: 4, thumbnail: null };
    await fs.write("documents/book.kfx", "BOOK"); await fs.write("documents/other/deep.kfx", "x"); await writeManifest(fs.root, { version: 1, books: [record] }); fs.operations = [];
    await deleteBook(device, "book.kfx");
    const ops = fs.operations, index = (operation: string, path: string) => ops.findIndex(o => o.operation === operation && o.path === path);
    expect(ops.some(o => o.path === "/documents/book.kfx" && o.operation === "getFile")).toBe(false);
    // Listing documents/ names its children; nothing descends into them or other folders.
    expect(ops.some(o => o.operation !== "iterate" && (o.path.startsWith("/documents/other") || o.path.startsWith("/fonts")))).toBe(false);
    expect(index("remove", "/documents/book.kfx")).toBeGreaterThan(index("close", "/.bindery/manifest.json"));
    expect((await readManifest(fs.root)).books).toEqual([]); await expect(fs.text(".bindery/pending.json")).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("finishes an interrupted deletion forward and rolls back one that had not started", async () => {
    const record = { book_id: "a".repeat(32), filename: "book.kfx", content_id: "ABC", cde_content_type: "EBOK" as const, profile_id: "default", profile_name: "默认", transferred_at: new Date().toISOString(), size: 4, thumbnail: null };
    const setup = async () => { const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"); await fs.write("documents/book.kfx", "BOOK"); await writeManifest(fs.root, { version: 1, books: [record] }); return { fs, device }; };
    // Unplugged right after the book was removed, before the journal recorded the commit.
    const forward = await setup(); let removed = false;
    forward.fs.beforeOperation = o => { if (removed) forward.fs.unplug(); if (o.operation === "remove" && o.path === "/documents/book.kfx") removed = true; };
    await expect(deleteBook(forward.device, "book.kfx")).rejects.toMatchObject({ name: "NotFoundError" });
    forward.fs.beforeOperation = undefined; forward.fs.plug(); await recoverDevice(forward.fs.root);
    await expect(forward.fs.text("documents/book.kfx")).rejects.toMatchObject({ name: "NotFoundError" }); expect((await readManifest(forward.fs.root)).books).toEqual([]);
    await expect(forward.fs.text(".bindery/pending.json")).rejects.toMatchObject({ name: "NotFoundError" });
    // Unplugged before the book was touched: the manifest returns to its backup and the book stays.
    const back = await setup();
    back.fs.beforeOperation = o => { if (o.operation === "remove" && o.path === "/documents/book.kfx") back.fs.unplug(); };
    await expect(deleteBook(back.device, "book.kfx")).rejects.toMatchObject({ name: "NotFoundError" });
    back.fs.beforeOperation = undefined; back.fs.plug(); await recoverDevice(back.fs.root);
    expect(await back.fs.text("documents/book.kfx")).toBe("BOOK"); expect((await readManifest(back.fs.root)).books).toEqual([record]);
  });
  it("refuses a tampered recovery path before touching any protected file", async () => {
    const fs = await fakeKindle(); await fs.write(".bindery/pending.json", JSON.stringify({ version: 1, committed: false, backups: [{ path: ["system", "version.txt"], kind: null }] })); fs.operations = [];
    await expect(recoverDevice(fs.root)).rejects.toThrow("受保护");
    expect(fs.operations.some(o => o.path === "/system/version.txt")).toBe(false); expect(await fs.text("system/version.txt")).toBe("Kindle 5.16.2.1.1");
  });
  it("enumerates nested books and removes only the matching nested book and sidecar", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    await fs.write("documents/作者/书名.azw3", "book"); await fs.write("documents/作者/书名.sdr/position", "state"); await fs.write("documents/作者/其他.txt", "other"); await fs.write("documents/System Volume Information/keep.txt", "protected"); fs.operations = [];
    const result = await inventory(fs.root); expect(result.books.map(b => b.filename).sort()).toEqual(["作者/书名.azw3", "作者/其他.txt"]); expect(result.books.find(b => b.filename.endsWith("azw3"))?.sidecar).toBe("作者/书名.sdr"); expect(result.usage.books).toBe(9);
    expect(fs.operations.filter(o => o.path.includes("System Volume Information") && o.operation !== "iterate")).toEqual([]);
    await deleteBook(device, "作者/书名.azw3"); expect(await fs.text("documents/作者/其他.txt")).toBe("other"); await expect(fs.bytes("documents/作者/书名.sdr/position")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(deleteBook(device, "System Volume Information/keep.txt")).rejects.toThrow("受保护");
  });
});
