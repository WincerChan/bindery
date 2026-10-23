import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { readArchive } from "../src/core/archive";
import { convertToKepub } from "../src/core/kepub";
import { KindleTransferService } from "../src/client/kindle/transfer";
import { KoboTransferService } from "../src/client/devices/kobo/transfer";
import type { KepubConversionOptions } from "../src/client/devices/kobo/kepub-client";
import { detectDevice, pairDetectedDevice } from "../src/client/devices/identity";
import { pairDevice } from "../src/client/kindle/identity";
import { EMPTY_SETTINGS, defaultProfile } from "../src/client/devices/profiles";
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
