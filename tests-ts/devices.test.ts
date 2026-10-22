import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { convertToKepub } from "../src/core/kepub";
import { detectDevice, pairDetectedDevice, parseIdentity, parseKoboVersion, readIdentity } from "../src/client/devices/identity";
import { DeviceManager } from "../src/client/devices/device";
import type { HandleRepository, RememberedDevice } from "../src/client/devices/remembered";
import { applyDevicePatchesFor, validateDevicePath } from "../src/client/devices/transaction";
import { deviceInventory, inventory, isKoboBook } from "../src/client/devices/inventory";
import { deleteBook } from "../src/client/devices/operations";
import { fontTargetName, installFonts, listFonts } from "../src/client/devices/fonts";
import { koboBookFilename } from "../src/client/devices/paths";
import { LocalStorageDevicePreference, MemoryDevicePreference } from "../src/client/devices/preferences";
import type { DeviceFont } from "../src/client/devices/fonts";
import { KoboTransferService } from "../src/client/devices/kobo/transfer";
import { fakeKindle, fakeKobo, FakeFileSystem } from "./support/fake-fs";

class MemoryHandles implements HandleRepository {
  devices = new Map<string, RememberedDevice>();
  async list() { return [...this.devices.values()]; }
  async put(value: RememberedDevice) { this.devices.set(value.id, value); }
  async remove(id: string) { this.devices.delete(id); }
}
function fontFile(filename: string, family: string, style = "Regular") {
  const encode = (text: string) => { const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer); for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i)); return bytes; };
  const strings = [encode(family), encode(style)], length = 6 + 24 + strings.reduce((n, v) => n + v.length, 0), bytes = new Uint8Array(28 + length), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, 1); bytes.set(new TextEncoder().encode("name"), 12); view.setUint32(20, 28); view.setUint32(24, length); view.setUint16(30, 2); view.setUint16(32, 30);
  let offset = 0;
  for (let i = 0; i < 2; i++) { const at = 34 + i * 12; view.setUint16(at, 3); view.setUint16(at + 2, 1); view.setUint16(at + 4, 0x409); view.setUint16(at + 6, i ? 17 : 16); view.setUint16(at + 8, strings[i].length); view.setUint16(at + 10, offset); bytes.set(strings[i], 58 + offset); offset += strings[i].length; }
  return new File([bytes], filename);
}

describe("device kind detection and multi-device memory", () => {
  it("recognizes Kindle, known/unknown Kobo, and rejects unrelated directories", async () => {
    const kindle = await fakeKindle(), kobo = await fakeKobo("N418"), unknown = await fakeKobo("N999");
    expect(await detectDevice(kindle.root)).toMatchObject({ kind: "kindle", model: "KPW3", firmware: "Kindle 5.16.2.1.1" });
    expect(await detectDevice(kobo.root)).toMatchObject({ kind: "kobo", model: "libra2", modelCode: "N418", productUuid: "00000000-0000-0000-0000-000000000388", firmware: "4.38.23171" });
    expect(await detectDevice(unknown.root)).toMatchObject({ kind: "kobo", model: "unknown", modelCode: "N999", productUuid: "00000000-0000-0000-0000-000000000388" });
    await expect(detectDevice(new FakeFileSystem().root)).rejects.toThrow("请选择 Kindle 磁盘根目录");
    expect(isKoboBook("Bindery/A.kepub.epub")).toBe(true); expect(isKoboBook("A.epub")).toBe(true); expect(isKoboBook("A.kfx")).toBe(false);
  });
  it("pairs Kobo with kind/product metadata and reads legacy Kindle identities", async () => {
    const kobo = await fakeKobo("N418"), detection = await detectDevice(kobo.root), paired = await pairDetectedDevice(kobo.root, detection, detection.model, "我的 Libra 2");
    expect(paired.identity).toMatchObject({ kind: "kobo", model: "libra2", model_code: "N418", name: "我的 Libra 2", product_id: "00000000-0000-0000-0000-000000000388" });
    expect(JSON.parse(await kobo.text(".bindery/device.json"))).toMatchObject({ kind: "kobo", model: "libra2", model_code: "N418" });
    const real = parseKoboVersion("N418123456789,4.1.15,4.38.23171,4.1.15,4.1.15,00000000-0000-0000-0000-000000000388");
    expect(real).toMatchObject({ serial: "N418123456789", modelCode: "N418", firmware: "4.38.23171", productUuid: "00000000-0000-0000-0000-000000000388" });
    expect(parseKoboVersion("serial,4.1.15,,4.1.15,4.1.15,uuid")).toMatchObject({ modelCode: null, firmware: null, productUuid: "uuid" });
    const kindle = await fakeKindle(); await kindle.write(".bindery/device.json", JSON.stringify({ id: "legacy", model: "KPW3", name: "旧 Kindle", created_at: "2020-01-01T00:00:00Z" }));
    expect(await readIdentity(kindle.root, "kindle")).toMatchObject({ kind: "kindle", model: "KPW3" });
    expect(() => parseIdentity({ id: "x", kind: "kobo", model: "", name: "x", created_at: "2020-01-01T00:00:00Z" })).toThrow();
  });
  it("remembers both kinds and switches the current device by ID", async () => {
    const handles = new MemoryHandles(), kindle = await fakeKindle(), kobo = await fakeKobo("N418"), roots = [kindle.root, kobo.root];
    let index = 0; const manager = new DeviceManager(handles, async () => roots[index++]!);
    await manager.pick(); await manager.pair("KPW3", "Paperwhite");
    await manager.pick(); await manager.pair("libra2", "Libra 2");
    expect(manager.snapshot().device?.identity.kind).toBe("kobo");
    const remembered = await manager.remembered(); expect(remembered.map(d => d.identity.kind).sort()).toEqual(["kindle", "kobo"]);
    await manager.restore(remembered.find(d => d.identity.kind === "kindle")!);
    expect(manager.snapshot().device?.identity.kind).toBe("kindle");
    await manager.forget(remembered.find(d => d.identity.kind === "kobo")!.id);
    expect((await manager.remembered()).map(d => d.identity.kind)).toEqual(["kindle"]);
  });
});

describe("Kobo write policy, books, transfer, deletion and fonts", () => {
  it("accepts only Bindery KEPUBs, fonts and device.json", async () => {
    for (const path of [["Bindery", "A.kepub.epub"], ["Bindery", "作者", "A.kepub.epub"], ["fonts", "A-Regular.ttf"], ["fonts", "A-Bold.otf"], [".bindery", "device.json"]]) expect(() => validateDevicePath(path, "kobo")).not.toThrow();
    for (const path of [["Bindery", "A.epub"], ["Bindery", "A.txt"], ["documents", "A.kepub.epub"], ["fonts", "A.woff"], ["KoboReader.sqlite"], [".kobo", "version"]]) expect(() => validateDevicePath(path, "kobo")).toThrow("受保护");
    expect(() => validateDevicePath(["Bindery", "..", "A.kepub.epub"], "kobo")).toThrow("非法文件名");
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    await applyDevicePatchesFor(fs.root, "kobo", [{ path: ["Bindery", "OK.kepub.epub"], data: "book" }]);
    expect(await fs.text("Bindery/OK.kepub.epub")).toBe("book");
    await expect(applyDevicePatchesFor(fs.root, "kobo", [{ path: ["Bindery", "NO.epub"], data: "book" }])).rejects.toThrow("受保护");
    await expect(fs.bytes("Bindery/NO.epub")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(applyDevicePatchesFor(fs.root, "kobo", [{ path: ["KoboReader.sqlite"], data: null }])).rejects.toThrow("受保护");
    expect(device.identity.kind).toBe("kobo");
  });
  it("lists Bindery and external EPUB/KEPUB files, skips system folders, and marks sources", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    await fs.write("Bindery/Managed.kepub.epub", "managed"); await fs.write("Other/External.epub", "external"); await fs.write("Root.EPUB", "root");
    await fs.write(".kobo/Hidden.epub", "hidden"); await fs.write("fonts/Readme.txt", "font readme");
    const result = await inventory(fs.root, "kobo");
    expect(result.books.map(b => [b.filename, b.source, b.format])).toEqual([["Bindery/Managed.kepub.epub", "Bindery", "kepub"], ["Other/External.epub", "其他", "epub"], ["Root.EPUB", "其他", "epub"]]);
    expect(result.books.some(book => book.filename.includes(".kobo"))).toBe(false);
    expect(result.usage.books).toBe(7 + 8 + 4);
    expect((await deviceInventory(device)).books).toHaveLength(3);
    expect(koboBookFilename("A / B: C?")).toBe("A _ B_ C_.kepub.epub");
  });
  it("downloads, converts, writes and overwrites Bindery/<title>.kepub.epub", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    const fixture = new Uint8Array(readFileSync(new URL("./fixtures/parity/kepub/input-mixed.epub", import.meta.url)));
    const progress: string[] = [];
    const service = new KoboTransferService({
      fetch: async () => new Response(fixture, { headers: { "Content-Length": String(fixture.byteLength) } }),
      converter: { convert: async (data, options) => { strips.push(options?.strip); return { data: convertToKepub(data).data, stats: convertToKepub(data).stats }; } },
    });
    const strips: unknown[] = [];
    const record = await service.transferBook(device, "a".repeat(32), "default", { stripFonts: false, stripImages: false, stripPageMargins: true, progress: value => progress.push(`${value.phase}:${value.state}`) });
    // Stripping happens inside the converter's worker; the service only forwards the choice.
    expect(strips[0]).toEqual({ stripFonts: false, stripImages: false, stripPageMargins: true });
    expect(record.filename).toBe("KEPUB fixture.kepub.epub");
    expect(progress).toContain("download:转换"); expect(progress).toContain("convert:转换"); expect(progress).toContain("finalize:完成");
    const bytes = await fs.bytes(`Bindery/${record.filename}`); expect(bytes.byteLength).toBe(record.size);
    const books = (await inventory(fs.root, "kobo")).books; expect(books).toEqual([expect.objectContaining({ filename: `Bindery/${record.filename}`, source: "Bindery" })]);
    await service.transferBook(device, "a".repeat(32), "default");
    expect((await inventory(fs.root, "kobo")).books).toHaveLength(1);
    await expect(fs.bytes(".bindery/pending.json")).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("deletes only managed Bindery KEPUBs", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    await fs.write("Bindery/A.kepub.epub", "managed"); await fs.write("Other/B.epub", "external"); fs.operations = [];
    await deleteBook(device, "Bindery/A.kepub.epub");
    await expect(fs.bytes("Bindery/A.kepub.epub")).rejects.toMatchObject({ name: "NotFoundError" });
    // A deletion neither copies the book into the rollback nor walks the rest of the device.
    expect(fs.operations.filter(o => o.operation === "getFile" && o.path.endsWith(".epub"))).toEqual([]);
    expect(fs.operations.filter(o => o.operation !== "iterate" && o.path.startsWith("/Other"))).toEqual([]);
    await expect(deleteBook(device, "Bindery/A.kepub.epub")).rejects.toThrow("设备书籍不存在");
    await expect(deleteBook(device, "Other/B.epub")).rejects.toThrow("受保护");
    expect(await fs.text("Other/B.epub")).toBe("external");
  });
  it("renames Kobo fonts to Family-Regular/Bold/Italic/BoldItalic and groups them", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    const files = [fontFile("random.ttf", "Book Serif", "Regular"), fontFile("Bold.otf", "Book Serif", "Bold"), fontFile("Italic.ttf", "Book Serif", "Italic"), fontFile("BoldItalic.ttf", "Book Serif", "Bold Italic")];
    const base: DeviceFont = { filename: "", family: "Book Serif", style: "Regular", weight: 400, italic: false, coverage: "R", size: 1 };
    expect(fontTargetName("kobo", base, "random.ttf")).toBe("Book Serif-Regular.ttf");
    expect(fontTargetName("kobo", { ...base, weight: 700, coverage: "B" }, "Bold.otf")).toBe("Book Serif-Bold.otf");
    expect(fontTargetName("kobo", { ...base, italic: true, coverage: "I" }, "Italic.ttf")).toBe("Book Serif-Italic.ttf");
    expect(fontTargetName("kobo", { ...base, italic: true, weight: 700, coverage: "BI" }, "BoldItalic.ttf")).toBe("Book Serif-BoldItalic.ttf");
    await installFonts(device, files);
    expect((await fs.text("fonts/Book Serif-Regular.ttf")).length).toBeGreaterThan(0);
    const families = await listFonts(fs.root, undefined, "kobo");
    expect(families).toHaveLength(1); expect(families[0]!.coverage.sort()).toEqual(["B", "BI", "I", "R"]);
  });
});

it("degrades safely when browser storage is unavailable", () => {
  const broken = new LocalStorageDevicePreference({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  });
  expect(broken.get()).toBeNull(); expect(() => broken.set("x")).not.toThrow(); expect(() => broken.clear()).not.toThrow();
  const memory = new MemoryDevicePreference("a"); memory.set("b"); expect(memory.get()).toBe("b"); memory.clear(); expect(memory.get()).toBeNull();
});
