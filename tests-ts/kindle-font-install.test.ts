import { afterEach, describe, expect, it, vi } from "vitest";
import { installFonts, type FontInstallProgress } from "../src/client/kindle/fonts";
import { errorMessage, WRITE_CHUNK_SIZE } from "../src/client/kindle/fs";
import { pairDevice } from "../src/client/kindle/identity";
import { PROGRESS_INTERVAL_MS } from "../src/client/kindle/progress";
import { recoverDevice, withDeviceLock } from "../src/client/kindle/transaction";
import { fakeKindle } from "./support/fake-fs";

function font(name: string, size = 12) {
  const bytes = new Uint8Array(size);
  bytes.set(name.endsWith(".otf") ? [79, 84, 84, 79] : [0, 1, 0, 0]);
  return new File([bytes], name);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("font installation write progress", () => {
  it("writes File slices with monotonic batch/file totals, throttles byte updates and flushes commits and completion", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    const files = [font("CJK-Regular.ttf", 8 * WRITE_CHUNK_SIZE + 17), font("CJK-Bold.otf", 4 * WRITE_CHUNK_SIZE + 31)];
    const reads = files.map(file => vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Do not buffer an entire font")));
    const events: { value: FontInstallProgress; at: number }[] = [];
    vi.useFakeTimers(); fs.writeLatencyMs = path => path.startsWith("/fonts/") ? 30 : 0;
    fs.beforeOperation = operation => {
      if (operation.operation === "close" && operation.path.startsWith("/fonts/")) {
        const latest = events.at(-1)!.value;
        expect(latest.committing).toBe(true);
        expect(latest.files.every(file => file.state !== "完成")).toBe(true);
      }
    };
    const pending = installFonts(device, files, { onProgress: value => events.push({ value, at: Date.now() }) });
    await vi.runAllTimersAsync(); await pending;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    expect(events[0]!.value).toMatchObject({ state: "等待", loaded: 0, total, files: [{ state: "等待" }, { state: "等待" }] });
    for (let i = 0; i < events.length; i++) {
      const { value } = events[i]!;
      expect(value.total).toBe(total);
      expect(value.files.map(file => file.total)).toEqual(files.map(file => file.size));
      expect(value.loaded).toBe(value.files.reduce((sum, file) => sum + file.loaded, 0));
      if (i) {
        expect(value.loaded).toBeGreaterThanOrEqual(events[i - 1]!.value.loaded);
        value.files.forEach((file, index) => expect(file.loaded).toBeGreaterThanOrEqual(events[i - 1]!.value.files[index]!.loaded));
      }
    }
    for (const file of files) {
      const byteEvents = events.filter(({ value }) => value.currentFile === file.name && value.state === "写入" && !value.committing && value.files.find(row => row.filename === file.name)!.loaded < file.size);
      for (let i = 1; i < byteEvents.length; i++) expect(byteEvents[i]!.at - byteEvents[i - 1]!.at).toBeGreaterThanOrEqual(PROGRESS_INTERVAL_MS);
      const commits = events.filter(({ value }) => value.currentFile === file.name && value.committing);
      expect(commits).toHaveLength(1); expect(commits[0]!.value.files.find(row => row.filename === file.name)!.loaded).toBe(file.size);
    }
    const measured = events.find(({ value }) => value.etaSeconds && value.bytesPerSecond && value.files.some(file => file.bytesPerSecond && file.etaSeconds));
    expect(measured).toBeDefined();
    expect(events.at(-1)!.value).toMatchObject({ state: "完成", loaded: total, total, committing: false, etaSeconds: 0, files: files.map(file => ({ filename: file.name, state: "完成", loaded: file.size, total: file.size })) });
    expect(events.at(-1)!.at).toBe(events.at(-2)!.at); // Final flush bypasses the throttle.
    expect(events.length).toBeLessThan(18);
    reads.forEach(read => expect(read).not.toHaveBeenCalled());
    fs.beforeOperation = undefined;
    for (const file of files) expect(Buffer.from(await fs.bytes(`fonts/${file.name}`)).equals(new Uint8Array(await file.slice().arrayBuffer()))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["write", "close"])("rolls back the earlier file and aborts the current stream when cancelled during the second file's %s", async during => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle");
    await fs.write("fonts/Existing.ttf", "preserve font"); await fs.write("fonts/Readme.txt", "preserve readme");
    await fs.write("documents/book.sdr/position", "preserve reading state");
    const identity = await fs.text(".bindery/device.json"), controller = new AbortController(), events: FontInstallProgress[] = [];
    let chunks = 0;
    fs.beforeOperation = operation => { if (operation.path === "/fonts/Second.otf" && operation.operation === during && (during === "close" || ++chunks === 2)) controller.abort(); };
    await expect(installFonts(device, [font("First.ttf"), font("Second.otf", 3 * WRITE_CHUNK_SIZE)], { signal: controller.signal, onProgress: value => events.push(value) })).rejects.toMatchObject({ name: "AbortError" });
    fs.beforeOperation = undefined;
    expect(fs.operations.some(op => op.operation === "close" && op.path === "/fonts/First.ttf")).toBe(true);
    expect(fs.operations.some(op => op.operation === "abort" && op.path === "/fonts/Second.otf")).toBe(true);
    const entries = []; for await (const entry of (await fs.root.getDirectoryHandle("fonts")).values()) entries.push(entry.name);
    expect(entries.sort()).toEqual(["Existing.ttf", "Readme.txt"]);
    expect(await fs.text("fonts/Existing.ttf")).toBe("preserve font"); expect(await fs.text("fonts/Readme.txt")).toBe("preserve readme");
    expect(await fs.text("documents/book.sdr/position")).toBe("preserve reading state"); expect(await fs.text(".bindery/device.json")).toBe(identity);
    await expect(fs.bytes(".bindery/pending.json")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect((await fs.root.getDirectoryHandle(".bindery")).getDirectoryHandle("rollback")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(events.some(event => event.state === "完成" || event.files.some(file => file.state === "完成"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ state: "失败", committing: false, message: "操作已取消", files: [{ state: "失败" }, { state: "失败" }] });
  });

  it("does not start a write when cancelled before installation or while waiting for the device lock", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), controller = new AbortController();
    controller.abort(); fs.operations = [];
    await expect(installFonts(device, [font("Preaborted.ttf")], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.operations).toEqual([]);
    let release!: () => void;
    const lock = withDeviceLock(device, () => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeDefined());
    const queued = new AbortController(), pending = installFonts(device, [font("Queued.ttf")], { signal: queued.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    queued.abort(); release(); await lock; await rejected;
    expect(fs.operations.some(op => op.operation === "createWritable" && op.path.startsWith("/fonts/"))).toBe(false);
  });

  it("reports unplug as failure and recovers the whole batch after reconnect", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), events: FontInstallProgress[] = [];
    await fs.write("fonts/Keep.ttf", "keep");
    fs.beforeOperation = operation => { if (operation.operation === "write" && operation.path === "/fonts/Second.otf") fs.unplug(); };
    let failure: unknown;
    try { await installFonts(device, [font("First.ttf"), font("Second.otf", 2 * WRITE_CHUNK_SIZE)], { onProgress: value => events.push(value) }); } catch (error) { failure = error; }
    expect(errorMessage(failure)).toBe("Kindle 已断开，请重新插入后重试");
    expect(events.at(-1)).toMatchObject({ state: "失败", message: "Kindle 已断开，请重新插入后重试", files: [{ state: "失败" }, { state: "失败" }] });
    expect(events.some(value => value.state === "完成")).toBe(false);
    fs.beforeOperation = undefined; fs.plug();
    expect(JSON.parse(await fs.text(".bindery/pending.json")).committed).toBe(false);
    await recoverDevice(fs.root);
    expect(await fs.text("fonts/Keep.ttf")).toBe("keep");
    for (const name of ["First.ttf", "Second.otf"]) await expect(fs.bytes(`fonts/${name}`)).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("rejects a Windows long path before writing any font in the batch", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), events: FontInstallProgress[] = [];
    fs.operations = [];
    await expect(installFonts(device, [font("Short.ttf"), font(`${"字".repeat(250)}.ttf`)], { onProgress: value => events.push(value) })).rejects.toThrow("文件路径不适用于 Windows");
    expect(fs.operations.some(op => op.operation === "createWritable" && op.path.startsWith("/fonts/"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ state: "失败", loaded: 0, files: [{ state: "失败" }, { state: "失败" }] });
  });
});
