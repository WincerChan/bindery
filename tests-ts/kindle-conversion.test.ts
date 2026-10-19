import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { convertEpub } from "../src/client/boko/conversion";
import { ionField, ionFields, parseKfxEntities, readKfxIdentity, walkIon, type IonValue } from "../src/client/boko/kfx";
import { BokoConverter } from "../src/client/boko/client";
import { buildEpub } from "../src/core/epub";
import { metadataFromDict } from "../src/core/models";
import { parseBook } from "../src/core/parsing";
import { readArchive } from "../src/core/archive";
import { appendProfileCss } from "../src/client/kindle/epub";
import { defaultProfile, EMPTY_SETTINGS, generateProfileCss } from "../src/client/kindle/profiles";

const wasm = readFileSync(new URL("../vendor/boko/boko_bg.wasm", import.meta.url));
const epub = buildEpub(parseBook("书名：Kindle test\n第一章 开始\nThis paragraph verifies typesetting. 第二段正文。", "test"), metadataFromDict({ book_id: "a".repeat(32), title: "Kindle test", identifier: "urn:uuid:kindle-self-contained", language: "en" }));
let output: Awaited<ReturnType<typeof convertEpub>>;
beforeAll(async () => { output = await convertEpub(epub, wasm); });
describe("vendored boko WASM and KFX metadata", () => {
  it("converts real EPUB bytes, reads exact content_id/ASIN/type and emits honest stages", async () => {
    const stages: string[] = [], result = await convertEpub(epub, wasm, stage => stages.push(stage));
    expect(stages).toEqual(["loading", "inspecting", "converting", "metadata", "done"]);
    expect(result.identity).toEqual(output.identity); expect(result.identity.cdeContentType).toBe("EBOK");
    expect(result.identity.contentId).toMatch(/^[A-F0-9]{32}$/); expect(result.identity.asin).toBe(result.identity.contentId);
    expect(result.bookInfo.title).toBe("Kindle test"); expect(new TextDecoder().decode(result.data.subarray(0, 4))).toBe("CONT");
  });
  it("appends deterministic profile CSS without changing original metadata or styles, and reaches KFX styles", async () => {
    const profile = { ...defaultProfile("device"), id: "custom", builtIn: false, settings: { ...EMPTY_SETTINGS, textIndent: 3.25, fontFamily: "Kindle Test Serif", lineHeight: 1.75 } }, css = generateProfileCss(profile), before = epub.slice(), patched = appendProfileCss(epub, css);
    expect(generateProfileCss(profile)).toBe(css); expect(epub).toEqual(before);
    const original = readArchive(epub), modified = readArchive(patched);
    expect(modified.filter(e => e.name.endsWith(".css"))).toHaveLength(original.filter(e => e.name.endsWith(".css")).length + 1);
    for (const entry of original.filter(e => !/\.opf$|\.xhtml$/.test(e.name))) expect(modified.find(e => e.name === entry.name)?.data).toEqual(entry.data);
    const result = await convertEpub(patched, wasm), values: IonValue[] = [];
    for (const entity of parseKfxEntities(result.data, [157])) walkIon(entity.value, value => { values.push(value); });
    expect(values.some(v => ionFields(v).some(([key]) => key === 36))).toBe(true);
    expect(values).toContain("Kindle Test Serif");
    const indents = values.map(v => ionField(v, 36));
    expect(JSON.stringify(indents)).toContain("3.25");
    expect(result.identity).toEqual(output.identity);
    expect(appendProfileCss(epub, generateProfileCss(defaultProfile("device")))).toEqual(epub);
  });
  it("horizontal profile margins reach KFX styles (boko drops margins declared on body)", async () => {
    const marginsOf = async (css: string) => {
      const result = await convertEpub(appendProfileCss(epub, css), wasm), values: IonValue[] = [];
      for (const entity of parseKfxEntities(result.data, [157])) walkIon(entity.value, value => { values.push(value); });
      // $48 / $50 are margin-left / margin-right in KFX style fragments.
      return JSON.stringify([...values.map(v => ionField(v, 48)), ...values.map(v => ionField(v, 50))]);
    };
    const profile = { ...defaultProfile("device"), id: "custom", builtIn: false, settings: { ...EMPTY_SETTINGS, marginX: 2.75, marginY: 1.5 } };
    const css = generateProfileCss(profile);
    expect(css).not.toMatch(/margin-(top|bottom)/);
    expect(await marginsOf(css)).toContain("2.75");
    expect(await marginsOf("body { margin-left: 2.75em !important; margin-right: 2.75em !important; }")).not.toContain("2.75");
  });
  it("rejects invalid EPUB and corrupt/truncated KFX without native tools", async () => {
    await expect(convertEpub(new Uint8Array([1, 2, 3]), wasm)).rejects.toBeDefined();
    for (const length of [0, 4, 17, 35, output.data.length - 1]) expect(() => readKfxIdentity(output.data.subarray(0, length))).toThrow();
    const corrupted = output.data.slice(); corrupted.fill(255, 6, 10); expect(() => readKfxIdentity(corrupted)).toThrow();
    const pdoc = output.data.slice(), typeOffset = Buffer.from(pdoc).indexOf("EBOK"); expect(typeOffset).toBeGreaterThan(0); pdoc.set(new TextEncoder().encode("PDOC"), typeOffset); expect(readKfxIdentity(pdoc).cdeContentType).toBe("PDOC");
  });
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null; onerror: ((event: ErrorEvent) => void) | null = null; onmessageerror: (() => void) | null = null;
  terminated = false; request!: { id: string; data: ArrayBuffer }; transferred: Transferable[] = [];
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: { id: string; data: ArrayBuffer }, transfer: Transferable[]) { this.request = message; this.transferred = transfer; }
  terminate() { this.terminated = true; }
}
describe("Worker lifecycle", () => {
  it("copies input, transfers buffers, enforces one job and cancels synchronous WASM by termination", async () => {
    const converter = new BokoConverter(() => new FakeWorker() as unknown as Worker), controller = new AbortController(), original = epub.slice();
    const promise = converter.convert(epub, { signal: controller.signal }), worker = FakeWorker.instances.at(-1)!;
    expect(worker.transferred).toEqual([worker.request.data]); expect(epub).toEqual(original);
    await expect(converter.convert(epub)).rejects.toThrow("已有");
    controller.abort(); await expect(promise).rejects.toMatchObject({ name: "AbortError" }); expect(worker.terminated).toBe(true);
    const next = converter.convert(epub), second = FakeWorker.instances.at(-1)!;
    second.onmessage!({ data: { id: second.request.id, result: output } } as MessageEvent); await expect(next).resolves.toBe(output); expect(second.terminated).toBe(true);
  });
  it("propagates worker and loading errors and can retry", async () => {
    const converter = new BokoConverter(() => new FakeWorker() as unknown as Worker), promise = converter.convert(epub), worker = FakeWorker.instances.at(-1)!;
    worker.onerror!({ message: "WASM missing" } as ErrorEvent); await expect(promise).rejects.toThrow("WASM missing"); expect(worker.terminated).toBe(true);
    const retry = converter.convert(epub), next = FakeWorker.instances.at(-1)!; next.onmessage!({ data: { id: next.request.id, error: "bad EPUB" } } as MessageEvent); await expect(retry).rejects.toThrow("bad EPUB");
  });
});
