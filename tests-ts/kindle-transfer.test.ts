import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { convertEpub } from "../src/client/boko/conversion";
import { buildEpub } from "../src/core/epub";
import { metadataFromDict } from "../src/core/models";
import { parseBook } from "../src/core/parsing";
import { readArchive } from "../src/core/archive";
import { fakeKindle } from "./support/fake-fs";
import { pairDevice } from "../src/client/kindle/identity";
import { collisionSafeFilename, KindleTransferService, safeBookStem, type TransferDependencies } from "../src/client/kindle/transfer";
import { defaultProfile, EMPTY_SETTINGS } from "../src/client/kindle/profiles";
import { readManifest } from "../src/client/kindle/manifest";
import { inventory } from "../src/client/kindle/inventory";
import { deleteBook } from "../src/client/kindle/operations";
import { recoverDevice } from "../src/client/kindle/transaction";
import { TransferQueue } from "../src/client/kindle/queue";

const bookId = "a".repeat(32), wasm = readFileSync(new URL("../vendor/boko/boko_bg.wasm", import.meta.url)), cover = readFileSync(new URL("./fixtures/cover 中文.png", import.meta.url));
const epub = new Uint8Array(buildEpub(parseBook("书名：Transfer Book\n第一章\n正文 paragraph", "source"), metadataFromDict({ book_id: bookId, title: "Transfer Book", identifier: "urn:uuid:transfer-tests" }), { cover: { name: "cover.png", data: cover } }));
let converted: Awaited<ReturnType<typeof convertEpub>>;
beforeAll(async () => { converted = await convertEpub(epub, wasm); });
const thumbnail = new Uint8Array([255, 216, 255, 217]);
function service(overrides: Partial<TransferDependencies> = {}) {
  const fetched: RequestInit[] = [], inputs: Uint8Array[] = [];
  const dependencies: TransferDependencies = {
    converter: { async convert(data) { inputs.push(data); return converted; } },
    fetch: async (_url, options) => { fetched.push(options!); return new Response(epub); },
    profile: async (deviceId, id) => id === "default" ? defaultProfile(deviceId) : { ...defaultProfile(deviceId), id, name: "自定义", builtIn: false, settings: { ...EMPTY_SETTINGS, textIndent: 3.25 } },
    thumbnail: async bytes => { expect(bytes).toEqual(new Uint8Array(cover)); return thumbnail; }, ...overrides,
  };
  return { transfer: new KindleTransferService(dependencies), fetched, inputs };
}
const settleQueue = async (queue: TransferQueue) => {
  for (let i = 0; i < 1000; i++) { if (queue.snapshot().every(j => j.state === "完成" || j.state === "失败")) return; await Promise.resolve(); }
  throw new Error("queue did not settle");
};
describe("transfer pipeline and device-side recovery", () => {
  it("patches only a copy, converts, writes actual KFX identity thumbnail, commits manifest and deletes sidecars", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Paperwhite"), { transfer, fetched, inputs } = service(), original = epub.slice(), progress: string[] = [];
    const record = await transfer.transferBook(device, bookId, "custom", { progress: state => progress.push(state) });
    expect(fetched[0]).toMatchObject({ credentials: "same-origin", redirect: "error" }); expect(epub).toEqual(original);
    expect(readArchive(inputs[0]).some(e => e.name.endsWith("bindery-kindle-profile.css") && new TextDecoder().decode(e.data).includes("3.25em"))).toBe(true);
    expect(record).toMatchObject({ content_id: converted.identity.contentId, cde_content_type: "EBOK", profile_id: "custom", profile_name: "自定义", size: converted.data.length });
    expect(await fs.bytes(`documents/${record.filename}`)).toEqual(converted.data); expect(await fs.bytes(`system/thumbnails/${record.thumbnail}`)).toEqual(thumbnail); expect((await readManifest(fs.root)).books).toEqual([record]);
    expect(progress).toEqual(["转换", "写入", "完成"]); expect((await inventory(fs.root)).books[0].source).toBe("Bindery");
    await fs.write(`documents/${record.filename.replace(/\.kfx$/, ".sdr")}/position`, "keep until deletion");
    await deleteBook(device, record.filename); expect((await readManifest(fs.root)).books).toEqual([]); await expect(fs.bytes(`system/thumbnails/${record.thumbnail}`)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(fs.bytes(`documents/${record.filename.replace(/\.kfx$/, ".sdr")}/position`)).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("uses collision-safe Windows filenames and never overwrites an unrelated file, folder or sidecar", async () => {
    const fs = await fakeKindle(); await fs.write("documents/Transfer Book.KFX", "outside"); await fs.mkdir("documents/Transfer Book (2).kfx"); await fs.mkdir("documents/Transfer Book (3).sdr");
    expect(await collisionSafeFilename(await fs.root.getDirectoryHandle("documents"), "Transfer Book", fs.root)).toBe("Transfer Book (4).kfx");
    expect(safeBookStem("CON.txt")).toBe("_CON.txt"); expect(safeBookStem("../bad:name?*")).not.toMatch(/[/:?*]/); expect(safeBookStem("... ")).toBe("book"); expect(new TextEncoder().encode(safeBookStem("中".repeat(200))).length).toBeLessThanOrEqual(180);
    const device = await pairDevice(fs.root, "KPW3", "Kindle"), { transfer } = service();
    const first = await transfer.transferBook(device, bookId); const second = await transfer.transferBook(device, bookId); expect([first.filename, second.filename]).toEqual(["Transfer Book (4).kfx", "Transfer Book (5).kfx"]); expect(await fs.text("documents/Transfer Book.KFX")).toBe("outside");
    await fs.write("documents/Transfer Book (4).sdr/position", "keep");
    const overwrite = await transfer.transferBook(device, bookId, "default", { overwrite: true }); expect(overwrite.filename).toBe(first.filename); expect((await readManifest(fs.root)).books).toHaveLength(2); expect(await fs.text("documents/Transfer Book (4).sdr/position")).toBe("keep");
    await deleteBook(device, first.filename); expect(await fs.bytes(`system/thumbnails/${second.thumbnail}`)).toEqual(thumbnail); // shared thumbnail retained
  });
  it("never deletes another application's thumbnail or protected directories", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), { transfer } = service();
    const thumb = `thumbnail_${converted.identity.contentId}_EBOK_portrait.jpg`; await fs.write(`system/thumbnails/${thumb}`, "external cover");
    await expect(transfer.transferBook(device, bookId)).rejects.toThrow("无法安全覆盖"); expect(await fs.text(`system/thumbnails/${thumb}`)).toBe("external cover"); expect((await readManifest(fs.root)).books).toEqual([]);
    await fs.write("documents/other.azw3", "outside"); await fs.write("documents/other.sdr/position", "sidecar"); fs.operations = [];
    await deleteBook(device, "other.azw3"); expect(await fs.text(`system/thumbnails/${thumb}`)).toBe("external cover");
    const writes = fs.operations.filter(o => ["write", "remove", "close", "createWritable"].includes(o.operation)); expect(writes.every(o => /^\/(documents|\.bindery)\//.test(o.path))).toBe(true);
  });
  it("recovers unplug during KFX write and during manifest close using persistent rollback data", async () => {
    for (const brokenPath of ["/documents/Transfer Book.kfx", "/.bindery/manifest.json"]) {
      const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), { transfer } = service();
      fs.beforeOperation = o => { if (o.path === brokenPath && o.operation === "close") fs.unplug(); };
      await expect(transfer.transferBook(device, bookId)).rejects.toMatchObject({ name: "NotFoundError" });
      fs.beforeOperation = undefined; fs.plug(); await recoverDevice(fs.root); expect((await readManifest(fs.root)).books).toEqual([]); expect((await inventory(fs.root)).books).toEqual([]);
      const retry = await transfer.transferBook(device, bookId); expect(retry.filename).toBe("Transfer Book.kfx");
    }
  });
  it("restores an existing Bindery copy, manifest, thumbnail and reading state if overwrite fails", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), { transfer } = service(), first = await transfer.transferBook(device, bookId);
    await fs.write(`documents/${first.filename.replace(/\.kfx$/, ".sdr")}/position`, "reading"); const previous = await fs.text(".bindery/manifest.json");
    fs.beforeOperation = o => { if (o.operation === "close" && o.path === "/.bindery/manifest.json") fs.unplug(); };
    await expect(transfer.transferBook(device, bookId, "custom", { overwrite: true })).rejects.toMatchObject({ name: "NotFoundError" }); fs.beforeOperation = undefined; fs.plug(); await recoverDevice(fs.root);
    expect(await fs.text(".bindery/manifest.json")).toBe(previous); expect(await fs.bytes(`documents/${first.filename}`)).toEqual(converted.data); expect(await fs.bytes(`system/thumbnails/${first.thumbnail}`)).toEqual(thumbnail); expect(await fs.text(`documents/${first.filename.replace(/\.kfx$/, ".sdr")}/position`)).toBe("reading");
  });
  it("handles unplug while converting, download failures, cancellation and conversion failure before writing", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    const disconnect = service({ converter: { async convert() { fs.unplug(); return converted; } } }); await expect(disconnect.transfer.transferBook(device, bookId)).rejects.toMatchObject({ name: "NotFoundError" }); fs.plug(); expect((await readManifest(fs.root)).books).toEqual([]);
    await expect(service({ fetch: async () => new Response("", { status: 500 }) }).transfer.transferBook(device, bookId)).rejects.toThrow("500");
    await expect(service({ converter: { async convert() { throw new Error("bad EPUB"); } } }).transfer.transferBook(device, bookId)).rejects.toThrow("bad EPUB");
    const controller = new AbortController(), cancel = service({ converter: { async convert() { controller.abort(); return converted; } } }); await expect(cancel.transfer.transferBook(device, bookId, "default", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const missingFont = service({ profile: async deviceId => ({ ...defaultProfile(deviceId), id: "missing-font", builtIn: false, settings: { ...EMPTY_SETTINGS, fontFamily: "Not Installed" } }) }); await expect(missingFont.transfer.transferBook(device, bookId, "missing-font")).rejects.toThrow("未安装字体");
    expect((await inventory(fs.root)).books).toEqual([]);
  });
  it("recovers permission revocation during write after explicit reauthorization", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), { transfer } = service();
    fs.beforeOperation = o => { if (o.operation === "close" && o.path === "/.bindery/manifest.json") fs.permission = "prompt"; };
    await expect(transfer.transferBook(device, bookId)).rejects.toMatchObject({ name: "NotAllowedError" });
    fs.beforeOperation = undefined; fs.permission = "granted"; await recoverDevice(fs.root); expect((await readManifest(fs.root)).books).toEqual([]); expect((await inventory(fs.root)).books).toEqual([]);
  });
  it.each(["documents/Transfer Book.kfx", ".bindery/manifest.json", `system/thumbnails/thumbnail_${"PLACEHOLDER"}_EBOK_portrait.jpg`])("reports a reachable-device write failure at %s and restores book/manifest consistency", async input => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), { transfer } = service();
    const path = input.replace("PLACEHOLDER", converted.identity.contentId);
    fs.injectFailure("close", path, "NotFoundError");
    await expect(transfer.transferBook(device, bookId)).rejects.toMatchObject({ name: "EntryAccessError", issue: { path, reason: "NotFoundError" } });
    expect((await readManifest(fs.root)).books).toEqual([]); expect((await inventory(fs.root)).books).toEqual([]);
    fs.failures.clear(); await recoverDevice(fs.root);
    expect((await transfer.transferBook(device, bookId)).filename).toBe("Transfer Book.kfx");
  });
});
describe("SPA transfer queue", () => {
  it("executes sequentially, survives subscriber navigation and continues after failure", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), order: string[] = [], completions: Array<() => void> = [];
    let active = 0, maxActive = 0;
    const queue = new TransferQueue({ async transferBook(_device, id, _profile, options) {
      active++; maxActive = Math.max(maxActive, active); order.push(id); options?.progress?.("转换", "converting"); await new Promise<void>(resolve => completions.push(resolve)); active--;
      if (id === "bad") throw new Error("conversion failed"); return { book_id: id, filename: `${id}.kfx` } as never;
    } });
    const first = queue.enqueue(device, "bad"), second = queue.enqueue(device, "good"), cancelled = queue.enqueue(device, "cancelled"); const updates: unknown[] = [], unsubscribe = queue.subscribe(value => updates.push(value)); unsubscribe(); queue.cancel(cancelled);
    expect(queue.snapshot().find(i => i.id === first)?.state).toBe("转换"); expect(queue.snapshot().find(i => i.id === second)?.state).toBe("等待");
    completions.shift()!(); for (let i = 0; i < 30; i++) await Promise.resolve(); completions.shift()!(); await settleQueue(queue);
    expect(order).toEqual(["bad", "good"]); expect(maxActive).toBe(1); expect(queue.snapshot().map(i => i.state)).toEqual(["失败", "完成", "失败"]); expect(updates).toEqual([]);
    expect(queue.snapshot()[0].message).toBe("conversion failed"); queue.clearFinished(); expect(queue.snapshot()).toEqual([]);
  });
});
