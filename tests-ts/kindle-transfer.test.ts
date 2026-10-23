import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { convertEpub } from "../src/client/boko/conversion";
import { buildEpub } from "../src/core/epub";
import { metadataFromDict } from "../src/core/models";
import { parseBook } from "../src/core/parsing";
import { readArchive } from "../src/core/archive";
import { fakeKindle } from "./support/fake-fs";
import { pairDevice } from "../src/client/kindle/identity";
import { collisionSafeFilename, KindleTransferService, safeBookStem, type TransferDependencies } from "../src/client/kindle/transfer";
import { defaultProfile, EMPTY_SETTINGS } from "../src/client/devices/profiles";
import { readManifest } from "../src/client/kindle/manifest";
import { inventory } from "../src/client/kindle/inventory";
import { deleteBook } from "../src/client/kindle/operations";
import { recoverDevice } from "../src/client/kindle/transaction";
import { TransferQueue } from "../src/client/kindle/queue";
import { WRITE_CHUNK_SIZE, writeBytes } from "../src/client/kindle/fs";
import { TransferProgressReporter, type TransferProgress } from "../src/client/kindle/progress";
import { assetEpub } from "./support/kindle-assets";
import { EpubArchive } from "../src/core/epub";

const bookId = "a".repeat(32), wasm = readFileSync(new URL("../vendor/boko/boko_bg.wasm", import.meta.url)), cover = readFileSync(new URL("./fixtures/cover 中文.png", import.meta.url));
const epub = new Uint8Array(buildEpub(parseBook("书名：Transfer Book\n第一章\n正文 paragraph", "source"), metadataFromDict({ book_id: bookId, title: "Transfer Book", identifier: "urn:uuid:transfer-tests" }), { cover: { name: "cover.png", data: cover } }));
let converted: Awaited<ReturnType<typeof convertEpub>>;
beforeAll(async () => { converted = await convertEpub(epub, wasm); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const thumbnail = new Uint8Array([255, 216, 255, 217]);
function service(overrides: Partial<TransferDependencies> = {}) {
  const fetched: RequestInit[] = [], inputs: Uint8Array[] = [];
  const dependencies: TransferDependencies = {
    converter: { async convert(data) { inputs.push(data); return converted; } },
    fetch: async (_url, options) => { fetched.push(options!); return new Response(epub); },
    profile: async id => id === "default" ? defaultProfile() : { ...defaultProfile(), id, name: "自定义", builtIn: false, settings: { ...EMPTY_SETTINGS, textIndent: 3.25 } },
    thumbnail: async bytes => { expect(bytes).toEqual(new Uint8Array(cover)); return thumbnail; }, ...overrides,
  };
  return { transfer: new KindleTransferService(dependencies), fetched, inputs };
}
const settleQueue = async (queue: TransferQueue) => {
  for (let i = 0; i < 1000; i++) { if (queue.snapshot().every(j => j.state === "完成" || j.state === "失败")) return; await Promise.resolve(); }
  throw new Error("queue did not settle");
};
describe("transfer pipeline and device-side recovery", () => {
  it("passes both asset toggles to conversion while retaining the original cover for the Kindle thumbnail", async () => {
    const original = assetEpub(), before = original.slice(), fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    const { transfer, inputs } = service({ fetch: async () => new Response(original), profile: async () => ({ ...defaultProfile(), id: "stripped", builtIn: false, settings: { ...EMPTY_SETTINGS, stripFonts: true, stripImages: true } }) });
    const record = await transfer.transferBook(device, bookId, "stripped"), archive = new EpubArchive(inputs[0]);
    expect(archive.entries.some(entry => entry.name.includes("/Fonts/"))).toBe(false);
    expect(archive.entries.filter(entry => entry.name.includes("/Images/")).map(entry => entry.name)).toEqual(["EPUB/Images/cover.png"]);
    expect(await fs.bytes(`system/thumbnails/${record.thumbnail}`)).toEqual(thumbnail); expect(original).toEqual(before);
  });
  it("patches only a copy, converts, writes actual KFX identity thumbnail, commits manifest and deletes sidecars", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Paperwhite"), { transfer, fetched, inputs } = service(), original = epub.slice(), progress: string[] = [];
    const record = await transfer.transferBook(device, bookId, "custom", { progress: value => { if (progress.at(-1) !== value.state) progress.push(value.state); } });
    expect(fetched[0]).toMatchObject({ credentials: "same-origin", redirect: "error" }); expect(epub).toEqual(original);
    expect(readArchive(inputs[0]).some(e => e.name.endsWith("bindery-profile.css") && new TextDecoder().decode(e.data).includes("3.25em"))).toBe(true);
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
    const missingFont = service({ profile: async () => ({ ...defaultProfile(), id: "missing-font", builtIn: false, settings: { ...EMPTY_SETTINGS, fontFamily: "Not Installed" } }) }); await expect(missingFont.transfer.transferBook(device, bookId, "missing-font")).rejects.toThrow("未安装字体");
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
      active++; maxActive = Math.max(maxActive, active); order.push(id); options?.progress?.({ state: "转换", phase: "convert", message: "converting", startedAt: Date.now(), phaseStartedAt: Date.now() }); await new Promise<void>(resolve => completions.push(resolve)); active--;
      if (id === "bad") throw new Error("conversion failed"); return { book_id: id, filename: `${id}.kfx` } as never;
    } });
    const first = queue.enqueue(device, "bad"), second = queue.enqueue(device, "good"), cancelled = queue.enqueue(device, "cancelled"); const updates: unknown[] = [], unsubscribe = queue.subscribe(value => updates.push(value)); unsubscribe(); queue.cancel(cancelled);
    expect(queue.snapshot().find(i => i.id === first)?.state).toBe("转换"); expect(queue.snapshot().find(i => i.id === second)?.state).toBe("等待");
    completions.shift()!(); for (let i = 0; i < 30; i++) await Promise.resolve(); completions.shift()!(); await settleQueue(queue);
    expect(order).toEqual(["bad", "good"]); expect(maxActive).toBe(1); expect(queue.snapshot().map(i => i.state)).toEqual(["失败", "完成", "失败"]); expect(updates).toEqual([]);
    expect(queue.snapshot()[0].message).toBe("conversion failed"); queue.clearFinished(); expect(queue.snapshot()).toEqual([]);
  });

  it("retries only failed items, with their original options and only on their own device", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), other = await pairDevice((await fakeKindle()).root, "KO3", "Kindle");
    const calls: Array<[string, string, unknown]> = []; let fail = true;
    const queue = new TransferQueue({ async transferBook(_device, id, profile, options) {
      calls.push([id, profile, { overwrite: options.overwrite, settings: options.settings }]);
      if (fail) throw new Error("Kindle 已断开，请重新插入后重试"); return { filename: `${id}.kfx`, size: 1 };
    } });
    const settings = { ...EMPTY_SETTINGS, stripFonts: true };
    const failed = queue.enqueue(device, "a", "wide", { overwrite: true, settings }); await settleQueue(queue);
    expect(queue.snapshot()[0]).toMatchObject({ id: failed, state: "失败" });
    expect(() => queue.retry(failed, other)).toThrow("请先连接这本书的目标设备");
    fail = false; const retried = queue.retry(failed, device)!; await settleQueue(queue);
    expect(queue.snapshot().map(i => [i.id, i.state])).toEqual([[retried, "完成"]]);
    expect(calls).toEqual([["a", "wide", { overwrite: true, settings }], ["a", "wide", { overwrite: true, settings }]]);
    expect(queue.retry(retried, device)).toBeUndefined();
  });
});

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function largeConversion() {
  // Retain real WASM metadata while expanding the injected converter's transport payload.
  const data = new Uint8Array(WRITE_CHUNK_SIZE * 3 + 37); data.set(converted.data);
  return { ...converted, data };
}
describe("real transfer progress", () => {
  it.each([true, false])("streams EPUB bytes with monotonic, throttled progress (Content-Length: %s)", async known => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    vi.useFakeTimers();
    const events: { value: TransferProgress; at: number }[] = [];
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      await delay(10);
      if (offset === epub.length) { controller.close(); return; }
      const end = Math.min(epub.length, offset + Math.ceil(epub.length / 30));
      controller.enqueue(epub.slice(offset, end)); offset = end;
    } });
    const { transfer, inputs } = service({ fetch: async () => new Response(stream, { headers: known ? { "Content-Length": String(epub.length) } : {} }) });
    const pending = transfer.transferBook(device, bookId, "default", { progress: value => events.push({ value, at: Date.now() }) });
    await vi.runAllTimersAsync(); await pending;
    const downloads = events.filter(e => e.value.phase === "download" && e.value.loaded! > 0);
    expect(inputs[0]).toEqual(epub);
    expect(downloads.at(-1)!.value.loaded).toBe(epub.length);
    expect(downloads.every((event, i) => i === 0 || event.value.loaded! >= downloads[i - 1].value.loaded!)).toBe(true);
    expect(downloads.length).toBeLessThanOrEqual(5); // 30 chunks over ~300 ms, plus the final flush.
    expect(downloads[0].value.bytesPerSecond).toBeGreaterThan(0);
    expect(downloads[0].value.total).toBe(known ? epub.length : undefined);
    if (known) {
      expect(downloads[0].value.etaSeconds).toBeCloseTo((epub.length - downloads[0].value.loaded!) / downloads[0].value.bytesPerSecond!);
      expect(downloads.at(-1)!.value.etaSeconds).toBe(0);
    } else expect(downloads.every(event => event.value.etaSeconds === undefined && event.value.total === undefined)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["known", "missing", "decoded"])("retains download counters across throttling and later queue phases (%s length)", async length => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    vi.useFakeTimers();
    let release!: () => void, converting!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { converting = resolve; });
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let offset = 0; offset < epub.length; offset += 100) controller.enqueue(epub.slice(offset, offset + 100));
      controller.close();
    } });
    const total = length === "known" ? epub.length : undefined;
    const { transfer } = service({
      fetch: async () => new Response(body, { headers: length === "missing" ? {} : { "Content-Length": String(length === "decoded" ? epub.length - 1 : epub.length) } }),
      converter: { async convert() { converting(); await gate; return converted; } },
    });
    const queue = new TransferQueue(transfer), snapshots: ReturnType<typeof queue.snapshot>[] = [];
    queue.subscribe(items => snapshots.push(items)); queue.enqueue(device, bookId);
    try {
      await started;
      const download = snapshots.flatMap(items => items).filter(item => item.phase === "download" && item.message === "正在下载 EPUB");
      expect(download.map(item => item.loaded)).toEqual([0, epub.length]);
      expect(download.at(-1)).toMatchObject({ loaded: epub.length, total, downloadedBytes: epub.length, downloadTotal: total });
      expect(queue.snapshot()[0]).toMatchObject({ phase: "convert", loaded: undefined, total: undefined, downloadedBytes: epub.length, downloadTotal: total });
    } finally { release(); await settleQueue(queue); }
    expect(queue.snapshot()[0]).toMatchObject({ state: "完成", downloadedBytes: epub.length, downloadTotal: total, writtenBytes: converted.data.length, writeTotal: converted.data.length });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending download reader and never starts conversion or a device transaction", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), controller = new AbortController();
    vi.useFakeTimers();
    const cancelled = vi.fn(), convert = vi.fn(async () => converted);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({ async pull(target) { if (!sent) { sent = true; await delay(120); target.enqueue(epub.slice(0, 100)); } }, cancel: cancelled });
    const { transfer } = service({ fetch: async () => new Response(stream), converter: { convert } });
    fs.operations = [];
    const events: TransferProgress[] = [];
    const pending = transfer.transferBook(device, bookId, "default", { signal: controller.signal, progress: value => events.push(value) });
    const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    setTimeout(() => controller.abort(), 200);
    await vi.runAllTimersAsync(); await failed;
    expect(cancelled).toHaveBeenCalledOnce(); expect(convert).not.toHaveBeenCalled();
    expect(events.some(value => value.phase === "download" && value.loaded === 100)).toBe(true);
    expect(fs.operations.some(o => o.operation === "createWritable")).toBe(false);
  });

  it("writes sequential 1 MiB chunks with exact totals, measured speed/ETA, and a distinct close step", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), output = largeConversion();
    vi.useFakeTimers(); fs.writeLatencyMs = path => path.startsWith("/documents/") ? 125 : 0;
    const events: TransferProgress[] = [], { transfer } = service({ converter: { convert: async () => output } });
    fs.beforeOperation = operation => {
      if (operation.operation === "close" && operation.path.startsWith("/documents/")) expect(events.at(-1)).toMatchObject({ state: "写入", phase: "finalize", message: "正在完成写入", loaded: output.data.length });
    };
    const pending = transfer.transferBook(device, bookId, "default", { progress: value => events.push(value) });
    await vi.runAllTimersAsync(); const record = await pending;
    const writes = events.filter(event => event.phase === "write");
    expect(writes.map(event => event.loaded)).toEqual([0, WRITE_CHUNK_SIZE, WRITE_CHUNK_SIZE * 2, WRITE_CHUNK_SIZE * 3, output.data.length]);
    expect(writes.every(event => event.total === output.data.length)).toBe(true);
    expect(writes.slice(1).reduce((sum, event, index) => sum + event.loaded! - writes[index].loaded!, 0)).toBe(output.data.length);
    expect(writes[1].bytesPerSecond).toBe(WRITE_CHUNK_SIZE / 0.125);
    expect(writes[1].etaSeconds).toBeCloseTo((output.data.length - WRITE_CHUNK_SIZE) / (WRITE_CHUNK_SIZE / 0.125));
    expect(writes.at(-1)!.etaSeconds).toBe(0);
    expect(writes.every(event => event.phaseStartedAt === writes[0].phaseStartedAt && event.startedAt <= event.phaseStartedAt)).toBe(true);
    expect(fs.operations.filter(o => o.operation === "write" && o.path === `/documents/${record.filename}`)).toHaveLength(4);
    expect(await fs.bytes(`documents/${record.filename}`)).toEqual(output.data);
    expect(events.at(-1)!.state).toBe("完成");
  });

  it("throttles byte updates but flushes phase boundaries and the final byte", () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const events: { value: TransferProgress; at: number }[] = [], reporter = new TransferProgressReporter(value => events.push({ value, at: Date.now() }));
    for (let loaded = 0; loaded <= 299; loaded++) {
      reporter.report({ state: "写入", phase: "write", message: "正在写入 Kindle", loaded, total: 300 }); vi.advanceTimersByTime(1);
    }
    reporter.report({ state: "写入", phase: "write", message: "正在写入 Kindle", loaded: 300, total: 300 }, true);
    reporter.report({ state: "写入", phase: "finalize", message: "正在完成写入" });
    expect(events.map(event => event.at)).toEqual([1000, 1100, 1200, 1300, 1300]);
    expect(events[3].value).toMatchObject({ loaded: 300, total: 300, bytesPerSecond: 1000, etaSeconds: 0, startedAt: 1000, phaseStartedAt: 1000 });
    expect(events[4].value).toMatchObject({ phaseStartedAt: 1300, loaded: undefined, total: undefined });
  });

  it("labels conversion estimates honestly, updates elapsed time, refines from session measurements and stops timers", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    vi.useFakeTimers();
    const { transfer } = service({ converter: { async convert(_bytes, options) {
      options?.progress?.("loading"); await delay(500); // Exclude initialization from measured WASM throughput.
      options?.progress?.("converting"); await delay(2000); options?.progress?.("metadata"); return converted;
    } } });
    const first: TransferProgress[] = [], second: TransferProgress[] = [];
    const pending = transfer.transferBook(device, bookId, "default", { progress: value => first.push(value) });
    await vi.runAllTimersAsync(); await pending;
    const initial = first.find(event => event.phase === "convert")!;
    expect(initial.etaSeconds).toBeCloseTo(0.3 + epub.length / (1024 * 1024) * 0.08);
    expect(initial.message).toContain("估计");
    expect(first.some(event => event.message.includes("已用 1.2 秒"))).toBe(true);
    expect(first.some(event => event.message.includes("已超出估计时间"))).toBe(true);
    expect(first.filter(event => event.phase === "convert").every(event => event.loaded === undefined && event.total === undefined && !event.message.includes("%"))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const next = transfer.transferBook(device, bookId, "default", { progress: value => second.push(value) });
    await vi.runAllTimersAsync(); await next;
    expect(second.find(event => event.phase === "convert")!.etaSeconds).toBeCloseTo(1.8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the estimate timer after conversion failure", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"); vi.useFakeTimers();
    const { transfer } = service({ converter: { async convert() { await delay(250); throw new Error("conversion failed"); } } });
    const failed = expect(transfer.transferBook(device, bookId, "default", { progress: () => {} })).rejects.toThrow("conversion failed");
    await vi.runAllTimersAsync(); await failed; expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["write", "close"])("rolls back a cancelled overwrite during %s, retaining manifest, thumbnail and reading state", async during => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), first = await service().transfer.transferBook(device, bookId);
    await fs.write(`documents/${first.filename.replace(/\.kfx$/, ".sdr")}/position`, "reading");
    const manifest = await fs.text(".bindery/manifest.json"), controller = new AbortController();
    let chunks = 0;
    fs.beforeOperation = operation => { if (operation.path === `/documents/${first.filename}` && operation.operation === during && (during === "close" || ++chunks === 2)) controller.abort(); };
    const { transfer } = service({ converter: { convert: async () => largeConversion() } });
    await expect(transfer.transferBook(device, bookId, "default", { overwrite: true, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    fs.beforeOperation = undefined;
    expect(await fs.bytes(`documents/${first.filename}`)).toEqual(converted.data);
    expect(await fs.text(".bindery/manifest.json")).toBe(manifest);
    expect(await fs.bytes(`system/thumbnails/${first.thumbnail}`)).toEqual(thumbnail);
    expect(await fs.text(`documents/${first.filename.replace(/\.kfx$/, ".sdr")}/position`)).toBe("reading");
    await expect(fs.bytes(".bindery/pending.json")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(fs.operations.some(operation => operation.operation === "abort" && operation.path === `/documents/${first.filename}`)).toBe(true);
  });

  it("fails the queue with a disconnect message on unplug mid-chunk and recovers after reconnect", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), { transfer } = service({ converter: { convert: async () => largeConversion() } });
    vi.useFakeTimers(); fs.writeLatencyMs = path => path.startsWith("/documents/") ? 120 : 0;
    let chunks = 0; fs.beforeOperation = operation => { if (operation.operation === "write" && operation.path.startsWith("/documents/") && ++chunks === 2) fs.unplug(); };
    const queue = new TransferQueue(transfer); queue.enqueue(device, bookId);
    await vi.runAllTimersAsync(); await settleQueue(queue);
    expect(queue.snapshot()[0]).toMatchObject({ state: "失败", message: "Kindle 已断开，请重新插入后重试", writtenBytes: 0, writeTotal: largeConversion().data.length });
    fs.beforeOperation = undefined; fs.plug();
    expect(JSON.parse(await fs.text(".bindery/pending.json")).committed).toBe(false);
    await recoverDevice(fs.root);
    expect((await readManifest(fs.root)).books).toEqual([]); expect((await inventory(fs.root)).books).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains KFX batch totals through finalization and completion, excluding metadata bytes", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), { transfer } = service();
    const queue = new TransferQueue(transfer), snapshots: ReturnType<typeof queue.snapshot>[] = [];
    queue.subscribe(items => snapshots.push(items)); queue.enqueue(device, bookId); queue.enqueue(device, bookId);
    await settleQueue(queue);
    expect(queue.snapshot().map(item => [item.writtenBytes, item.writeTotal])).toEqual([[converted.data.length, converted.data.length], [converted.data.length, converted.data.length]]);
    expect(snapshots.some(items => items.some(item => item.state === "写入" && item.phase === "finalize" && item.writtenBytes === converted.data.length))).toBe(true);
  });

  it("keeps the fake stream append position and atomic close semantics across writes", async () => {
    const fs = await fakeKindle(); await fs.write("documents/test.kfx", "old");
    const stream = await (await (await fs.root.getDirectoryHandle("documents")).getFileHandle("test.kfx")).createWritable();
    await stream.write("one"); await stream.write("two"); expect(await fs.text("documents/test.kfx")).toBe("old");
    await stream.close(); expect(await fs.text("documents/test.kfx")).toBe("onetwo");
    const controller = new AbortController(); controller.abort();
    await expect(writeBytes(await fs.root.getDirectoryHandle("documents"), "test.kfx", "new", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(await fs.text("documents/test.kfx")).toBe("onetwo");
  });
});
