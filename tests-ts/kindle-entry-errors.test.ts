import { describe, expect, it } from "vitest";
import { fakeKindle } from "./support/fake-fs";
import { KindleDeviceManager } from "../src/client/kindle/device";
import { pairDevice, readIdentity } from "../src/client/kindle/identity";
import { deviceInventory } from "../src/client/kindle/inventory";
import { deleteBook } from "../src/client/kindle/operations";
import { readManifest, writeManifest, thumbnailName } from "../src/client/kindle/manifest";
import { errorMessage, windowsPath } from "../src/client/kindle/fs";
import { installFonts } from "../src/client/kindle/fonts";
import { applyDevicePatches, recoverDevice } from "../src/client/kindle/transaction";
import { BOOK_STEM_BUDGET, collisionSafeFilename } from "../src/client/kindle/transfer";

async function connected() {
  const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "KPW3");
  const saved = { id: device.identity.id, identity: device.identity, root: fs.root };
  const manager = new KindleDeviceManager({ list: async () => [saved], put: async () => {}, remove: async () => {} });
  await manager.restore(saved);
  return { fs, device, manager };
}
const minimalFont = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("entry failures with a reachable device", () => {
  it.each(["NotFoundError", "NotReadableError", "InvalidStateError", "NotAllowedError"])("skips %s entries in every inventory area without double-counting fonts", async reason => {
    const { fs, device, manager } = await connected();
    await fs.write("documents/book.kfx", "BOOK"); await fs.write("documents/book.sdr/ok", "OK");
    const paths = ["documents/book.sdr/bad", "documents/missing.txt", "fonts/Bad.ttf", "system/thumbnails/bad.jpg", ".bindery/unknown.bin", "bad:name"];
    for (const path of paths) { await fs.write(path, "EXCLUDED"); fs.injectFailure("getFile", path, reason); }
    await fs.write("fonts/Good.ttf", minimalFont); await fs.write(".bindery/probe.json", '{"unknown":"keep"}');
    const expected = (await fs.bytes(".bindery/device.json")).length + (await fs.bytes("system/version.txt")).length + (await fs.bytes(".bindery/probe.json")).length + 2;
    const result = await deviceInventory(device);
    expect(result.books.map(b => b.filename)).toEqual(["book.kfx"]);
    expect(result.unreadableCount).toBe(paths.length);
    expect(result.unreadable.map(e => e.path).sort()).toEqual(paths.sort());
    expect(result.unreadable.every(e => e.reason === reason)).toBe(true);
    expect(result.unreadable.find(e => e.path === "bad:name")?.likelyCause).toContain("Windows 不支持");
    expect(result.usage).toMatchObject({ books: 4, fonts: minimalFont.length, other: expected, total: 4 + minimalFont.length + expected });
    await manager.probe(); expect(manager.snapshot().status).toBe("granted");
    expect(await fs.text(".bindery/probe.json")).toBe('{"unknown":"keep"}');
  });

  it("models Linux-created MAX_PATH sidecars, counts only readable data, and keeps the handle granted", async () => {
    const { fs, device, manager } = await connected(), stem = "长书名".repeat(38);
    await fs.write(`documents/${stem}.kfx`, "BOOK");
    for (const ext of ["yjf", "yjr", "yjr.bad_file"]) await fs.write(`documents/${stem}.sdr/${stem}${"a".repeat(32)}.${ext}`, "skip");
    fs.windowsPathLimit = 260;
    const result = await deviceInventory(device);
    expect(result.unreadableCount).toBe(3); expect(result.usage.books).toBe(4);
    expect(result.unreadable.every(e => e.windowsPathLength >= 260 && e.likelyCause.includes("260"))).toBe(true);
    await manager.probe(); expect(manager.snapshot().status).toBe("granted"); expect(fs.permission).toBe("granted");
  });

  it.each(["documents/book.sdr", "fonts", "system/thumbnails", ".bindery"])("isolates failed directory enumeration at %s", async path => {
    const { fs, device, manager } = await connected();
    await fs.write("documents/book.kfx", "BOOK"); await fs.mkdir("documents/book.sdr");
    fs.injectFailure("values", path, "NotReadableError");
    const result = await deviceInventory(device);
    expect(result.books).toHaveLength(1); expect(result.unreadable.some(e => e.path === path)).toBe(true);
    await manager.probe(); expect(manager.snapshot().status).toBe("granted");
  });

  it.each([".bindery/device.json", ".bindery/pending.json", "system/version.txt"])("does not treat an unreadable %s as an unplug or as an absent file", async path => {
    const { fs, manager } = await connected();
    if (path.endsWith("pending.json")) await fs.write(path, JSON.stringify({ version: 1, committed: true, backups: [] }));
    fs.injectFailure("getFile", path);
    await manager.probe(); expect(manager.snapshot().status).toBe("granted"); expect(manager.snapshot().message).not.toContain("已断开");
    if (path.endsWith("device.json")) await expect(readIdentity(fs.root)).rejects.toMatchObject({ name: "EntryAccessError", issue: { path } });
  });

  it("deletes the book and manifest/thumbnail even when only part of a long sidecar can be removed", async () => {
    const { fs, device, manager } = await connected(), stem = "a".repeat(114), filename = `${stem}.kfx`, thumbnail = thumbnailName("ABC", "EBOK");
    await fs.write(`documents/${filename}`, "BOOK"); await fs.write(`documents/${stem}.sdr/short`, "remove");
    const blocked = ["yjf", "yjr", "yjr.bad_file"].map(ext => `documents/${stem}.sdr/${stem}${"0".repeat(32)}.${ext}`);
    for (const path of blocked) await fs.write(path, "keep");
    await fs.write(`system/thumbnails/${thumbnail}`, "jpeg");
    await writeManifest(fs.root, { version: 1, books: [{ book_id: "a", filename, content_id: "ABC", cde_content_type: "EBOK", profile_id: "default", profile_name: "默认", transferred_at: new Date().toISOString(), size: 4, thumbnail }] });
    fs.windowsPathLimit = 260;
    fs.operations = [];
    const report = await deleteBook(device, filename);
    expect(report.removed).toBe(true); expect(report.notRemoved.map(e => e.path).sort()).toEqual(blocked.sort());
    expect((await readManifest(fs.root)).books).toEqual([]);
    await expect(fs.bytes(`documents/${filename}`)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(fs.bytes(`documents/${stem}.sdr/short`)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(fs.bytes(`system/thumbnails/${thumbnail}`)).rejects.toMatchObject({ name: "NotFoundError" });
    expect(fs.operations.filter(o => /:create|write|close/.test(o.operation)).every(o => windowsPath(o.path.replace(/^\//, "")).length < 260)).toBe(true);
    await manager.probe(); expect(manager.snapshot().status).toBe("granted");
    fs.windowsPathLimit = null; for (const path of blocked) expect(await fs.text(path)).toBe("keep");
  });

  it.each(["NotFoundError", "NotReadableError", "InvalidStateError", "NotAllowedError"])("continues sidecar deletion after a per-path %s remove failure", async reason => {
    const { fs, device } = await connected();
    await fs.write("documents/book.kfx", "BOOK"); await fs.write("documents/book.sdr/blocked", "keep"); await fs.write("documents/book.sdr/after", "remove");
    fs.injectFailure("remove", "documents/book.sdr/blocked", reason);
    const report = await deleteBook(device, "book.kfx");
    expect(report.notRemoved).toMatchObject([{ path: "documents/book.sdr/blocked", reason }]);
    await expect(fs.bytes("documents/book.sdr/after")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await fs.text("documents/book.sdr/blocked")).toBe("keep");
  });

  it("reports a font install write failure as local and rolls back the new font", async () => {
    const { fs, device, manager } = await connected(); fs.injectFailure("close", "fonts/Font.ttf", "NotAllowedError");
    await expect(installFonts(device, [new File([minimalFont], "Font.ttf")])).rejects.toMatchObject({ name: "EntryAccessError", issue: { path: "fonts/Font.ttf", reason: "NotAllowedError" } });
    await manager.probe(); expect(manager.snapshot().status).toBe("granted");
    await expect(fs.bytes("fonts/Font.ttf")).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("preserves destinations and the journal if a listed rollback file cannot be read", async () => {
    const { fs, device, manager } = await connected(); await fs.write("documents/book.kfx", "current"); await fs.write(".bindery/rollback/0", "original");
    await fs.write(".bindery/pending.json", JSON.stringify({ version: 1, committed: false, backups: [{ path: ["documents", "book.kfx"], kind: "file" }] }));
    fs.injectFailure("getFile", ".bindery/rollback/0");
    await expect(recoverDevice(fs.root)).rejects.toMatchObject({ name: "EntryAccessError", issue: { path: ".bindery/rollback/0" } });
    expect(await fs.text("documents/book.kfx")).toBe("current");
    await manager.probe(); expect(manager.snapshot().status).toBe("granted");
    expect((await deviceInventory(device)).unreadable.map(e => e.path)).toContain(".bindery/rollback/0");
    fs.failures.clear(); await recoverDevice(fs.root); expect(await fs.text("documents/book.kfx")).toBe("original");
  });

  it("keeps cleanup-only recovery retryable and includes remove-only failures in inventory notice data", async () => {
    const { fs, device, manager } = await connected();
    await fs.write(".bindery/rollback/0", "backup"); await fs.write(".bindery/pending.json", JSON.stringify({ version: 1, committed: true, backups: [] }));
    fs.injectFailure("remove", ".bindery/rollback", "NotAllowedError");
    const result = await deviceInventory(device);
    expect(result.unreadable).toMatchObject([{ path: ".bindery/rollback", reason: "NotAllowedError" }]);
    expect(JSON.parse(await fs.text(".bindery/pending.json")).committed).toBe(true);
    await manager.probe(); expect(manager.snapshot().status).toBe("granted"); expect(manager.snapshot().message).toContain(".bindery/rollback");
    fs.failures.clear(); await recoverDevice(fs.root); await expect(fs.text(".bindery/pending.json")).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("deletes the book despite inaccessible sidecar listing or thumbnail removal and reports both paths", async () => {
    const { fs, device } = await connected(), thumbnail = thumbnailName("ABC", "EBOK");
    await fs.write("documents/book.kfx", "BOOK"); await fs.write("documents/book.sdr/reading", "keep"); await fs.write(`system/thumbnails/${thumbnail}`, "jpeg");
    await writeManifest(fs.root, { version: 1, books: [{ book_id: "a", filename: "book.kfx", content_id: "ABC", cde_content_type: "EBOK", profile_id: "default", profile_name: "默认", transferred_at: new Date().toISOString(), size: 4, thumbnail }] });
    fs.injectFailure("values", "documents/book.sdr", "NotReadableError"); fs.injectFailure("remove", "documents/book.sdr", "NotAllowedError"); fs.injectFailure("remove", `system/thumbnails/${thumbnail}`, "InvalidStateError");
    const report = await deleteBook(device, "book.kfx");
    expect(report.notRemoved.map(e => e.path)).toEqual(["documents/book.sdr", `system/thumbnails/${thumbnail}`]);
    expect((await readManifest(fs.root)).books).toEqual([]); await expect(fs.bytes("documents/book.kfx")).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("still detects a real unplug during getFile and rejects unsafe internal writes", async () => {
    const { fs, device, manager } = await connected(); await fs.write("documents/book.kfx", "BOOK");
    fs.beforeOperation = op => { if (op.operation === "getFile" && op.path === "/documents/book.kfx") fs.unplug(); };
    await expect(deviceInventory(device)).rejects.toThrow("Kindle 已断开");
    await manager.probe(); expect(manager.snapshot().status).toBe("disconnected"); expect(manager.snapshot().message).toContain("已断开");
    fs.beforeOperation = undefined; fs.plug(); await manager.probe(); expect(manager.snapshot().status).toBe("granted");
    await expect(applyDevicePatches(fs.root, [{ path: ["fonts", `${"a".repeat(250)}.ttf`], data: "x" }])).rejects.toThrow("Windows");
    expect(errorMessage(new DOMException("entry missing", "NotFoundError"))).not.toContain("已断开");
  });
});

it.each(["x".repeat(500), "中文".repeat(200), "😀".repeat(200)])("budgets repeated Kindle sidecar stems including collision suffixes", async title => {
  const fs = await fakeKindle(), docs = await fs.root.getDirectoryHandle("documents"); fs.windowsPathLimit = 260;
  const names = [];
  for (let i = 0; i < 12; i++) {
    const name = await collisionSafeFilename(docs, title, fs.root), stem = name.slice(0, -4);
    expect(stem.length).toBeLessThanOrEqual(BOOK_STEM_BUDGET); expect(windowsPath(`documents/${stem}.sdr/${stem}${"0".repeat(32)}.yjr.bad_file`).length).toBeLessThanOrEqual(240);
    expect(stem).not.toMatch(/[. ]$/); expect(stem).not.toMatch(/[\uD800-\uDBFF]$/u);
    await fs.write(`documents/${name}`, "BOOK"); await fs.write(`documents/${stem}.sdr/${stem}${"0".repeat(32)}.yjr.bad_file`, "state"); names.push(name);
  }
  expect(new Set(names).size).toBe(12); expect(names[1]).toContain(" (2).kfx"); expect(names[11]).toContain(" (12).kfx");
});
