import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { readArchive, writeArchive } from "../src/core/archive";
import { convertToKepub, kepubEntryBytes, readKepubZip } from "../src/core/kepub";
import { convertForKobo } from "../src/core/kobo-kepub";
import { KindleTransferService } from "../src/client/kindle/transfer";
import { KoboTransferService } from "../src/client/devices/kobo/transfer";
import type { KepubConversionOptions } from "../src/client/devices/kobo/kepub-client";
import { detectDevice, pairDetectedDevice } from "../src/client/devices/identity";
import { pairDevice } from "../src/client/kindle/identity";
import { EMPTY_SETTINGS, defaultProfile } from "../src/client/devices/profiles";
import { EpubArchive } from "../src/core/epub";
import { assetEpub } from "./support/kindle-assets";
import { fakeKindle, fakeKobo } from "./support/fake-fs";

const bookId = "a".repeat(32), fixture = new Uint8Array(readFileSync(new URL("./fixtures/parity/kepub/input-mixed.epub", import.meta.url)));
const profile = (id: string, settings = EMPTY_SETTINGS) => ({ ...defaultProfile(), id, name: "已保存方案", builtIn: false, settings });
const cssText = (data: Uint8Array) => new TextDecoder().decode(readArchive(data).find(entry => entry.name.endsWith("bindery-profile.css"))!.data);

describe("transfer settings snapshots", () => {
  it("uses an unsaved Kindle snapshot instead of loading the saved profile", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), profileLoader = vi.fn(async () => { throw new Error("must not load"); });
    let captured: Uint8Array | undefined;
    const service = new KindleTransferService({ fetch: async () => new Response(fixture), converter: { async convert(data) { captured = data; throw new Error("conversion stop"); } }, profile: profileLoader, thumbnail: async () => new Uint8Array() });
    await expect(service.transferBook(device, bookId, "draft", { settings: { ...EMPTY_SETTINGS, textIndent: 3.25 } })).rejects.toThrow("conversion stop");
    expect(profileLoader).not.toHaveBeenCalled();
    expect(cssText(captured!)).toContain("text-indent: 3.25em");
  });
  it("loads a Kindle profile by id from the shared list when no snapshot is present", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), profileLoader = vi.fn(async () => profile("saved", { ...EMPTY_SETTINGS, lineHeight: 1.8 }));
    let captured: Uint8Array | undefined;
    const service = new KindleTransferService({ fetch: async () => new Response(fixture), converter: { async convert(data) { captured = data; throw new Error("conversion stop"); } }, profile: profileLoader, thumbnail: async () => new Uint8Array() });
    await expect(service.transferBook(device, bookId, "saved")).rejects.toThrow("conversion stop");
    expect(profileLoader).toHaveBeenCalledWith("saved");
    expect(cssText(captured!)).toContain("line-height: 1.8");
  });
  it("forwards a Kobo snapshot to the worker with settings and generated CSS", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    const convert = vi.fn(async (data: Uint8Array, _options?: KepubConversionOptions) => convertToKepub(data)), profileLoader = vi.fn(async () => { throw new Error("must not load"); });
    const service = new KoboTransferService({ fetch: async () => new Response(fixture), converter: { convert }, profile: profileLoader, fonts: async () => [] });
    await service.transferBook(device, bookId, "draft", { settings: { ...EMPTY_SETTINGS, stripPageMargins: true, textIndent: 2 } });
    expect(profileLoader).not.toHaveBeenCalled();
    expect(convert.mock.calls[0]![1]!.profile).toMatchObject({ settings: { stripPageMargins: true }, css: expect.stringContaining("text-indent: 2em") });
    expect(JSON.parse(await fs.text(".bindery/manifest.json")).books[0].settings).toEqual({ ...EMPTY_SETTINGS, stripPageMargins: true, textIndent: 2 });
  });
  it("loads a Kobo profile by id and checks its font against the device inventory", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    const converter = { convert: vi.fn(async (data: Uint8Array, _options?: KepubConversionOptions) => convertToKepub(data)) }, fetch = vi.fn(async () => new Response(fixture));
    const missing = new KoboTransferService({ fetch, converter, profile: async () => profile("saved", { ...EMPTY_SETTINGS, fontFamily: "Missing Font" }), fonts: async () => [] });
    await expect(missing.transferBook(device, bookId, "saved")).rejects.toThrow("Kobo 上未安装字体：Missing Font");
    expect(fetch).not.toHaveBeenCalled();
    const found = new KoboTransferService({ fetch, converter, profile: async () => profile("saved", { ...EMPTY_SETTINGS, fontFamily: "Installed Font" }), fonts: async () => [{ name: "Installed Font", fonts: [], coverage: [], size: 1 }] });
    await found.transferBook(device, bookId, "saved");
    expect(converter.convert.mock.calls[0]![1]!.profile!.css).toContain('font-family: "Installed Font"');
  });
  it("rejects a snapshot font missing from a Kobo before downloading", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra"), fetch = vi.fn(async () => new Response(fixture));
    const service = new KoboTransferService({ fetch, converter: { convert: async (data: Uint8Array) => convertToKepub(data) }, fonts: async () => [] });
    await expect(service.transferBook(device, bookId, "draft", { settings: { ...EMPTY_SETTINGS, fontFamily: "Missing Font" } })).rejects.toThrow("Kobo 上未安装字体：Missing Font");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("snapshot default-id handling", () => {
  it("applies a non-empty Kindle snapshot even when the profile id is default", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), input = assetEpub();
    let captured: Uint8Array | undefined;
    const service = new KindleTransferService({ fetch: async () => new Response(input), converter: { async convert(data) { captured = data; throw new Error("conversion stop"); } }, profile: async () => { throw new Error("must not load"); }, thumbnail: async () => new Uint8Array() });
    await expect(service.transferBook(device, bookId, "default", { settings: { ...EMPTY_SETTINGS, marginX: -4.9, stripImages: true } })).rejects.toThrow("conversion stop");
    const archive = new EpubArchive(captured!), names = archive.entries.map(entry => entry.name);
    expect(names).toContain("EPUB/bindery-profile.css");
    expect(names).not.toContain("EPUB/Images/art.png");
    expect(new TextDecoder().decode(archive.read("EPUB/bindery-profile.css")!)).toContain("margin-left: -4.9%");
  });
  it("returns the Kindle input bytes unchanged for an empty snapshot with a non-default id", async () => {
    const fs = await fakeKindle(), device = await pairDevice(fs.root, "KPW3", "Kindle"), input = assetEpub();
    let captured: Uint8Array | undefined;
    const service = new KindleTransferService({ fetch: async () => new Response(input), converter: { async convert(data) { captured = data; throw new Error("conversion stop"); } }, profile: async () => profile("custom"), thumbnail: async () => new Uint8Array() });
    await expect(service.transferBook(device, bookId, "custom", { settings: EMPTY_SETTINGS })).rejects.toThrow("conversion stop");
    expect(captured).toEqual(input);
  });
  it("applies a non-empty Kobo snapshot even when the profile id is default", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra");
    const encode = (value: string) => new TextEncoder().encode(value), input = writeArchive(readArchive(assetEpub()).map(entry => entry.name.endsWith("container.xml") ? { ...entry, data: encode(new TextDecoder().decode(entry.data).replace("<container ", '<container version="1.0" ')) } : entry));
    let converted: Uint8Array | undefined;
    const service = new KoboTransferService({ fetch: async () => new Response(input as Uint8Array<ArrayBuffer>), converter: { async convert(data, options) { const result = await convertForKobo(data, options); converted = result.data; return result; } }, fonts: async () => [] });
    await service.transferBook(device, bookId, "default", { settings: { ...EMPTY_SETTINGS, marginX: -4.9, stripImages: true } });
    const entries = new Map(readKepubZip(converted!).map(entry => [entry.name, new TextDecoder().decode(kepubEntryBytes(entry))]));
    expect(entries.has("EPUB/bindery-profile.css")).toBe(true);
    expect([...entries.keys()]).not.toContain("EPUB/Images/art.png");
  });

  it("applies line-height and paragraph-spacing snapshots on Kindle and Kobo", async () => {
    const encode = (value: string) => new TextEncoder().encode(value), decode = (value: Uint8Array) => new TextDecoder().decode(value);
    const styled = new Uint8Array(writeArchive(readArchive(assetEpub()).map(entry => entry.name.endsWith("book.css") ? { ...entry, data: encode("p { line-height: 2; margin: 1em 2em; }") } : entry.name.endsWith("container.xml") ? { ...entry, data: encode(decode(entry.data).replace("<container ", '<container version="1.0" ')) } : entry)));
    const settings = { ...EMPTY_SETTINGS, stripLineHeight: true, stripParagraphSpacing: true };
    const kindle = await fakeKindle(), kindleDevice = await pairDevice(kindle.root, "KPW3", "Kindle");
    let captured: Uint8Array | undefined;
    const kindleService = new KindleTransferService({ fetch: async () => new Response(styled), converter: { async convert(data) { captured = data; throw new Error("conversion stop"); } }, profile: async () => { throw new Error("must not load"); }, thumbnail: async () => new Uint8Array() });
    await expect(kindleService.transferBook(kindleDevice, bookId, "default", { settings })).rejects.toThrow("conversion stop");
    const kindleCss = decode(new EpubArchive(captured!).read("EPUB/Styles/book.css")!);
    expect(kindleCss).not.toContain("line-height");
    expect(kindleCss).toContain("margin-left: 2em; margin-right: 2em");

    const kobo = await fakeKobo(), koboDevice = await pairDetectedDevice(kobo.root, await detectDevice(kobo.root), "libra2", "Libra");
    let converted: Uint8Array | undefined;
    const koboService = new KoboTransferService({ fetch: async () => new Response(styled), converter: { async convert(data, options) { const result = await convertForKobo(data, options); converted = result.data; return result; } }, fonts: async () => [] });
    await koboService.transferBook(koboDevice, bookId, "default", { settings });
    const koboCss = new Map(readKepubZip(converted!).map(entry => [entry.name, decode(kepubEntryBytes(entry))])).get("EPUB/Styles/book.css")!;
    expect(koboCss).not.toContain("line-height");
    expect(koboCss).toContain("margin-left: 2em; margin-right: 2em");
    expect(JSON.parse(await kobo.text(".bindery/manifest.json")).books[0].settings).toEqual(settings);
  });

  it("passes the original Kobo bytes to the converter for an empty snapshot with a non-default id", async () => {
    const fs = await fakeKobo(), device = await pairDetectedDevice(fs.root, await detectDevice(fs.root), "libra2", "Libra"), convert = vi.fn(async (data: Uint8Array, options?: KepubConversionOptions) => { expect(data).toEqual(fixture); expect(options?.profile).toEqual({ settings: EMPTY_SETTINGS, css: "" }); return convertToKepub(data); });
    const service = new KoboTransferService({ fetch: async () => new Response(fixture), converter: { convert }, fonts: async () => [] });
    await service.transferBook(device, bookId, "custom", { settings: EMPTY_SETTINGS });
    expect(convert).toHaveBeenCalledOnce();
  });
});
