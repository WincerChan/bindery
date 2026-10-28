import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { binderyIcons } from "../scripts/vite-icons";
import solid from "vite-plugin-solid";
import { solidOptions } from "../scripts/solid-options";
import { DeviceManager } from "../src/client/devices/device";
import type { HandleRepository, RememberedDevice } from "../src/client/devices/remembered";
import type { DeviceKind } from "../src/client/devices/models";
import { EMPTY_SETTINGS, defaultProfile, type TypesettingProfile } from "../src/client/devices/profiles";
import { defaultReadingSettings, type DeviceReadingSettings } from "../src/client/devices/typeset";
import type { ProfileApi, ReadingApi } from "../src/features/devices/preview/preview-page";
import type { PreviewData } from "../src/features/devices/preview/model";
import { clientDocument, elements, fire } from "./support/client-dom";
import { previewDocumentFixture } from "./support/kindle-preview-dom";
import { fakeKindle, fakeKobo } from "./support/fake-fs";

type Props = { manager: DeviceManager | null; data: PreviewData; profiles: ProfileApi; reading: ReadingApi; chapters: (book: string) => Promise<{ title: string; item_path: string }[]>; initialFont?: string; onDirty?: (dirty: boolean) => void; queue?: unknown };
type Mounted = { dispose: () => void; flush: () => void };
type Bundle = { flush: () => void; markup: (props: Props) => string; mount: (root: HTMLElement, props: Props) => Mounted; manager: (repo: HandleRepository) => DeviceManager };
let ui: Bundle, ssr: Bundle;
const directory = mkdtempSync(join(tmpdir(), "bindery-devices-preview-")), disposers: (() => void)[] = [];
class Handles implements HandleRepository {
  devices = new Map<string, RememberedDevice>();
  async list() { return [...this.devices.values()]; }
  async put(device: RememberedDevice) { this.devices.set(device.id, device); }
  async remove(id: string) { this.devices.delete(id); }
}
const font = (name: string) => new File([new Uint8Array([...(name.endsWith(".otf") ? [79, 84, 84, 79] : [0, 1, 0, 0]), 0, 0, 0, 0, 0, 0, 0, 0])], name);
const data: PreviewData = { books: [{ id: "a", title: "甲", author: "作者" }, { id: "b", title: "乙", author: null }], bookId: "a", sections: [{ title: "第一章", item_path: "Text/第一 章.xhtml" }], error: "" };
const custom = (settings = { ...EMPTY_SETTINGS, marginX: 1, lineHeight: 1.6 }): TypesettingProfile => ({ id: "custom", name: "正文", builtIn: false, settings });
function api(): ProfileApi {
  return {
    list: vi.fn(async () => [defaultProfile(), custom()]),
    create: vi.fn(async input => ({ ...input, id: "new-profile", builtIn: false })),
    update: vi.fn(async input => ({ ...input, builtIn: false })),
    delete: vi.fn(async () => ({ ok: true })),
  };
}
function readingApi() {
  const store = new Map<string, DeviceReadingSettings>();
  const get = vi.fn(async (deviceId: string, kind: DeviceKind) => store.get(`${deviceId}:${kind}`) ?? defaultReadingSettings(kind));
  const save = vi.fn(async (deviceId: string, kind: DeviceKind, settings: DeviceReadingSettings) => { store.set(`${deviceId}:${kind}`, settings); });
  return { api: { get, save }, store, get, save };
}
function globals() {
  const page = clientDocument(), prototype = Object.getPrototypeOf(page.createElement("div"));
  page.addEventListener = vi.fn(); page.removeEventListener = vi.fn();
  const body = page.createElement("body"); body.dispatchEvent = vi.fn(() => true); Object.defineProperty(page, "body", { value: body, configurable: true });
  let focused: Element = body;
  Object.defineProperty(page, "activeElement", { configurable: true, get: () => focused });
  prototype.focus = function (this: Element) { focused = this; };
  vi.stubGlobal("showDirectoryPicker", vi.fn()); vi.stubGlobal("scrollTo", vi.fn());
  for (const key of ["width", "height"]) Object.defineProperty(prototype, key, { configurable: true,
    get(this: Element) { return Number(this.getAttribute(key)); }, set(this: Element, value: number) { this.setAttribute(key, String(value)); } });
  for (const key of ["disabled", "hidden"]) Object.defineProperty(prototype, key, { configurable: true,
    get(this: Element) { return this.hasAttribute(key); }, set(this: Element, value: boolean) { if (value) this.setAttribute(key, ""); else this.removeAttribute(key); } });
  const styles = new WeakMap<Element, object>();
  Object.defineProperty(prototype, "style", { configurable: true, get(this: Element) {
    if (!styles.has(this)) { const values = new Map<string, string>(); styles.set(this, { setProperty: (key: string, value: string) => { values.set(key, value); }, removeProperty: (key: string) => { values.delete(key); }, getPropertyValue: (key: string) => values.get(key) ?? "" }); }
    return styles.get(this);
  } });
  vi.stubGlobal("document", page); vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { confirm: vi.fn(() => true), location: new URL("http://bindery.local/devices/preview"), matchMedia: vi.fn(() => Object.assign(new EventTarget(), { matches: false })), getComputedStyle: vi.fn(() => ({ paddingLeft: "22px", paddingRight: "22px", paddingTop: "26px", paddingBottom: "54px" })) }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
}
beforeEach(globals);
beforeAll(async () => {
  globals();
  const entry = join(directory, "probe.tsx");
  writeFileSync(entry, `
    import { hydrate, renderToString } from "@solidjs/web";
    import { Loading, flush } from "solid-js";
    import { DevicePreviewPage } from ${JSON.stringify(resolve("src/features/devices/preview/preview-page.tsx"))};
    import { DeviceProvider } from ${JSON.stringify(resolve("src/features/devices/context.tsx"))};
    import { DeviceManager } from ${JSON.stringify(resolve("src/client/devices/device.ts"))};
    export const manager = repo => new DeviceManager(repo);
    function view(props) {
      const { manager, ...rest } = props;
      if (!manager) return <DevicePreviewPage {...rest} />;
      return <DeviceProvider manager={manager} queue={props.queue ?? { snapshot: () => [], subscribe: () => () => {}, enqueue: () => "queued", cancel: () => {}, retry: () => {}, clearFinished: () => {} }}><DevicePreviewPage {...rest} /></DeviceProvider>;
    }
    export function markup(props) { return renderToString(() => <Loading>{view(props)}</Loading>); }
    export function mount(root, props) { return { dispose: hydrate(() => <Loading>{view(props)}</Loading>, root), flush }; }
    export { flush };
  `);
  for (const server of [false, true]) {
    const result = await build({ configFile: false, logLevel: "silent", plugins: [...binderyIcons(),
      { name: "preview-rpc-boundary", enforce: "pre", resolveId(id, importer) {
        if (!importer) return;
        if (id.includes("server/typeset/functions")) return "\0preview-rpc";
        if (id.endsWith("/server/functions")) return "\0preview-auth";
        if (id === "@tanstack/solid-start") return "\0preview-start";
      }, load(id) {
        if (id === "\0preview-rpc") return "export const listTypesetProfiles = async () => { throw Error('unexpected RPC') }; export const createTypesetProfile = listTypesetProfiles; export const updateTypesetProfile = listTypesetProfiles; export const deleteTypesetProfile = listTypesetProfiles; export const getDeviceTypeset = listTypesetProfiles; export const saveDeviceTypeset = listTypesetProfiles;";
        if (id === "\0preview-auth") return "export const authenticated = {}";
        if (id === "\0preview-start") return "export function createServerFn() { const chain = { middleware: () => chain, validator: () => chain, handler: () => () => { throw Error('unexpected server RPC') } }; return chain; }";
      } },
      solid(solidOptions),
    ],
      resolve: { dedupe: ["solid-js", "@solidjs/web", "@tanstack/solid-router"], conditions: server ? ["node", "production"] : ["browser", "production"] },
      define: { "process.env.NODE_ENV": JSON.stringify("production") }, ssr: { noExternal: true },
      build: { write: false, minify: true, ...(server ? { ssr: entry } : { lib: { entry, formats: ["es" as const] } }), rollupOptions: { output: { inlineDynamicImports: true } } },
    });
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(chunk => chunk.type === "chunk" && chunk.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing preview probe");
    expect(chunk.imports.filter(id => !server || !["node:module", "module"].includes(id))).toEqual([]);
    const path = join(directory, server ? "server.mjs" : "client.mjs"); writeFileSync(path, chunk.code);
    const module = await import(/* @vite-ignore */ pathToFileURL(path).href) as Bundle;
    if (server) ssr = module; else ui = module;
  }
});
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.flush(); } };
async function paired(kind: DeviceKind = "kindle", files: string[] = []) {
  const fs = kind === "kobo" ? await fakeKobo() : await fakeKindle(), repo = new Handles(), manager = new DeviceManager(repo, async () => fs.root);
  await manager.pick(); await manager.pair(kind === "kobo" ? "libra2" : "KPW3", kind === "kobo" ? "我的 Libra" : "我的 Paperwhite");
  for (const name of files) await fs.write(`fonts/${name}`, new Uint8Array(await font(name).arrayBuffer()));
  return { fs, repo, manager, id: manager.snapshot().device!.identity.id };
}
function propsFor(manager: DeviceManager | null, extra: Partial<Props> = {}): Props {
  return { manager, data, profiles: api(), reading: readingApi().api, chapters: async () => [{ title: "第二章", item_path: "Text/b.xhtml" }], ...extra };
}
function mount(manager: DeviceManager | null, extra: Partial<Props> = {}, prepare?: (root: Element) => void) {
  const props = propsFor(manager, extra), root = document.createElement("div"); root.innerHTML = ssr.markup(props); document.documentElement.appendChild(root);
  prepare?.(root); vi.stubGlobal("_$HY", { r: {}, completed: new WeakSet(), events: [] });
  const mounted = ui.mount(root as HTMLElement, props); disposers.push(() => root.remove(), mounted.dispose);
  return { root, props, ...mounted };
}
const button = (root: Element, text: string) => elements(root, "button").find(element => element.textContent === text || element.getAttribute("aria-label") === text)!;
function setValue(node: Element, value: string, type = "input") {
  if (node.getAttribute("role") === "group") {
    const label = ({ narrow: "窄", medium: "中", wide: "宽" } as Record<string, string>)[value];
    fire(button(node, label), "click");
  } else {
    (node as HTMLInputElement).value = value;
    if (node.getAttribute("type") === "range") Object.defineProperty(node, "valueAsNumber", { configurable: true, value: Number(value) });
    fire(node, type);
  }
  ui.flush();
}
const rangeLabels: Record<string, string> = { "kt-marginX": "左右边距调整（%）", "kt-lineHeight": "行高" };
const input = (root: Element, id: string) => elements(root, "input").find(element => element.id === id || rangeLabels[id] && element.getAttribute("aria-label") === rangeLabels[id])!;
const labels = (root: Element, tag: string, label: string) => elements(root, tag).find(node => node.getAttribute("aria-label") === label) ?? elements(root, "label").find(element => element.firstChild?.textContent === label)?.getElementsByTagName(tag)[0] ?? elements(root, "div").find(node => node.getAttribute("role") === "group" && node.getAttribute("aria-label") === label)!;
function controlRow(node: Element): Element {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) if ((parent.getAttribute("class") ?? "").split(" ").includes("kt-range")) return parent;
  throw new Error("Missing control row");
}
const rangeRow = (root: Element, key: string) => controlRow(input(root, key));
const rangeOutput = (root: Element, key: string) => elements(withClass(rangeRow(root, key), "kt-range-value"), "output")[0]!;
const withClass = (root: Element, name: string) => elements(root, "*").find(node => node.className.split(/\s+/).includes(name))!;
const frame = (root: Element) => elements(root, "iframe")[0]!;
const bookBox = (root: Element) => elements(root, "input").find(element => element.getAttribute("role") === "combobox") as HTMLInputElement;
/** Open the book dropdown, type, then Enter: the way a person picks a book. */
function pickBook(root: Element, text: string) { const box = bookBox(root); fire(box, "focus"); ui.flush(); setValue(box, text); fire(box, "keydown", { key: "Enter" }); ui.flush(); }

it("renders one neutral page with both kinds available, no profile-owning device and the measured estimate", () => {
  const root = document.createElement("div"); root.innerHTML = ssr.markup(propsFor(null));
  expect(elements(root, "h2").map(node => node.textContent)).not.toContain("排版方案");
  expect(elements(root, "h3").map(node => node.textContent)).toContain("设备阅读设置（只用于预览）");
  expect(root.textContent).not.toContain("方案所属设备");
  expect(labels(root, "select", "预览设备")).toBeDefined(); expect(labels(root, "select", "方案")).toBeDefined();
  expect(labels(root, "select", "设备种类")).toBeDefined(); expect(elements(labels(root, "select", "设备种类"), "option").map(option => option.textContent)).toEqual(["Kindle", "Kobo"]);
  expect(labels(root, "select", "预览型号")).toBeDefined(); expect(elements(labels(root, "select", "预览型号"), "option").find(option => option.hasAttribute("selected"))?.getAttribute("value")).toBe("KPW3");
  expect(frame(root).getAttribute("width")).toBe("1072");
  expect(elements(root, "p", "data-kindle-line-estimate")[0]!.textContent).toContain("1072×1448");
  expect(elements(root, "p", "data-kindle-line-estimate")[0]!.textContent).toContain("实测");
  expect(input(root, "kt-marginX").hasAttribute("disabled")).toBe(false);
  expect(elements(root, "button").filter(node => node.textContent === "保存方案" || node.textContent === "删除")).toHaveLength(0);
  expect(elements(withClass(root, "kt-profile-actions"), "button").map(node => node.textContent)).toEqual(["还原", "另存为"]);
  expect(root.textContent).toContain("调整后可直接发送，不必保存为方案");
  expect(root.textContent).not.toContain("要调整边距、行高等，请新建方案");
  expect(withClass(root, "kt-preview-sticky")).toBeDefined();
  expect(withClass(root, "kt-device-space").parentElement).toBe(withClass(root, "kt-frame-wrap"));
  expect(frame(root).getAttribute("sandbox")).toBe("allow-same-origin");
  expect(withClass(root, "kt-calibration").hasAttribute("open")).toBe(false);
});

it("switches the preview device between Kindle and Kobo and updates geometry and preset controls", async () => {
  const { manager, id } = await paired(), mounted = mount(manager); await settle();
  expect(frame(mounted.root).getAttribute("width")).toBe("1072");
  expect(labels(mounted.root, "select", "预览设备").getAttribute("value") ?? (labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(id);
  expect(elements(labels(mounted.root, "select", "设备页边距"), "button").map(option => option.textContent)).toEqual(["窄", "中", "宽"]);
  setValue(labels(mounted.root, "select", "预览设备"), "", "change");
  setValue(labels(mounted.root, "select", "设备种类"), "kobo", "change");
  expect(frame(mounted.root).getAttribute("width")).toBe("1264");
  expect(elements(mounted.root, "label").find(label => label.firstChild?.textContent === "设备页边距")).toBeUndefined();
  expect(elements(mounted.root, "p", "data-reading-margin")[0]!.textContent).toBe("页边距：最小（实测）");
  setValue(labels(mounted.root, "select", "设备种类"), "kindle", "change");
  setValue(labels(mounted.root, "select", "预览型号"), "KO3", "change");
  expect(frame(mounted.root).getAttribute("width")).toBe("1264");
  expect(mounted.root.textContent).toContain("Kindle Oasis 3");
});

it("persists device reading settings for a paired device, debounced, and keeps model-only settings in memory", async () => {
  const { manager, id } = await paired(), reading = readingApi(), mounted = mount(manager, { reading: reading.api }); await settle();
  expect(reading.get).toHaveBeenCalledWith(id, "kindle");
  // Only the device margin is a reading setting; font size and line spacing are not offered.
  expect(input(mounted.root, "kt-reading-scale")).toBeUndefined(); expect(input(mounted.root, "kt-reading-line-height")).toBeUndefined();
  setValue(labels(mounted.root, "select", "设备页边距"), "wide", "change");
  await new Promise(resolve => setTimeout(resolve, 560)); await settle();
  expect(reading.save).toHaveBeenCalledWith(id, "kindle", { margin: "wide", profileId: "default" });
  const calls = reading.save.mock.calls.length;
  setValue(labels(mounted.root, "select", "预览设备"), "", "change");
  setValue(labels(mounted.root, "select", "设备页边距"), "medium", "change");
  await new Promise(resolve => setTimeout(resolve, 560)); await settle();
  expect(reading.save).toHaveBeenCalledTimes(calls);
  setValue(labels(mounted.root, "select", "设备种类"), "kobo", "change");
  expect(frame(mounted.root).getAttribute("width")).toBe("1264");
});

it("sends the unsaved draft as a settings snapshot and sends an empty snapshot for the built-in profile", async () => {
  const { manager } = await paired(), queue = { snapshot: () => [], subscribe: () => () => {}, enqueue: vi.fn(() => "queued"), cancel: () => {}, retry: () => {}, clearFinished: () => {} };
  const mounted = mount(manager, { queue }); await settle();
  fire(button(mounted.root, "发送到 我的 Paperwhite"), "click"); await settle();
  expect(queue.enqueue).toHaveBeenCalledWith(mounted.root ? expect.any(Object) : expect.any(Object), "a", "default", { settings: EMPTY_SETTINGS, overwrite: true });
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  setValue(input(mounted.root, "kt-marginX"), "2.5");
  fire(button(mounted.root, "发送到 我的 Paperwhite"), "click"); await settle();
  expect(queue.enqueue).toHaveBeenLastCalledWith(expect.any(Object), "a", "custom", { settings: expect.objectContaining({ marginX: 2.5, marginXUnit: "percent" }), profileName: "正文", overwrite: true });
});

it("sends an edited default without saving or loading a profile and clears the leave prompt after sending", async () => {
  const { manager } = await paired(), profiles = api(), onDirty = vi.fn();
  const queue = { snapshot: () => [], subscribe: () => () => {}, enqueue: vi.fn(() => "queued"), cancel: () => {}, retry: () => {}, clearFinished: () => {} };
  const mounted = mount(manager, { profiles, onDirty, queue }); await settle();
  setValue(input(mounted.root, "kt-marginX"), "2.5");
  expect(onDirty).toHaveBeenLastCalledWith(true);
  fire(button(mounted.root, "发送到 我的 Paperwhite"), "click"); await settle();
  expect(queue.enqueue).toHaveBeenLastCalledWith(expect.any(Object), "a", "default", { settings: expect.objectContaining({ marginX: 2.5, marginXUnit: "percent" }), overwrite: true });
  expect(profiles.create).not.toHaveBeenCalled(); expect(profiles.update).not.toHaveBeenCalled();
  expect(onDirty).toHaveBeenLastCalledWith(false);
  setValue(input(mounted.root, "kt-lineHeight"), "1.8");
  expect(onDirty).toHaveBeenLastCalledWith(true);
});

it("shows the overflow note without clamping or blocking a save", async () => {
  const { manager } = await paired(), mounted = mount(manager); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  setValue(input(mounted.root, "kt-marginX"), "-20");
  expect(mounted.root.textContent).toContain("左右边距超出设备自带边距，部分文字会被屏幕边缘切掉。");
  expect((button(mounted.root, "保存方案") as HTMLButtonElement).disabled).toBe(false);
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("-20");
});

it("edits the built-in default as an unsaved draft and saves it as a new global custom profile", async () => {
  const { manager } = await paired(), profiles = api(), mounted = mount(manager, { profiles }); await settle();
  const margin = input(mounted.root, "kt-marginX") as HTMLInputElement;
  expect(margin.disabled).toBe(false);
  setValue(margin, "2.5");
  expect(mounted.root.textContent).toContain("有未保存的修改");
  expect(elements(labels(mounted.root, "select", "方案"), "option").map(option => option.textContent)).toContain("默认 · 已调整（未保存）");
  expect(profiles.create).not.toHaveBeenCalled(); expect(profiles.update).not.toHaveBeenCalled();
  fire(button(mounted.root, "另存为方案"), "click"); ui.flush();
  setValue(labels(mounted.root, "input", "新方案名称"), "大字正文");
  fire(elements(mounted.root, "form")[0]!, "submit"); await settle();
  expect(profiles.create).toHaveBeenCalledWith({ name: "大字正文", settings: expect.objectContaining({ marginX: 2.5, marginXUnit: "percent" }) });
  fire(button(mounted.root, "增大首行缩进（em）"), "click"); ui.flush(); fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(profiles.update).toHaveBeenCalledWith(expect.objectContaining({ id: "new-profile", name: "大字正文", settings: expect.objectContaining({ textIndent: 2.5 }) }));
  expect(mounted.root.textContent).toContain("排版方案已保存，所有设备共用。");
  fire(button(mounted.root, "删除"), "click"); ui.flush();
  fire(button(elements(mounted.root, "dialog")[1]!, "确认"), "click"); await settle();
  expect(profiles.delete).toHaveBeenCalledWith("new-profile");
  expect(input(mounted.root, "kt-marginX").hasAttribute("disabled")).toBe(false);
});

it("rejects an invalid font query without breaking the page", async () => {
  const { manager } = await paired(), mounted = mount(manager, { initialFont: "bad\nfont" }); await settle();
  expect(mounted.root.textContent).toContain("无效的字体名称");
  expect((button(mounted.root, "另存为方案") as HTMLButtonElement).disabled).toBe(true);
  setValue(labels(mounted.root, "select", "字体（预览设备上已安装）"), "", "change");
  expect(mounted.root.textContent).not.toContain("无效的字体名称");
});

it("protects a dirty draft while changing the preview device", async () => {
  const first = await paired(), second = await paired("kobo"), profiles = api();
  await first.repo.put((await second.manager.remembered())[0]!);
  const mounted = mount(first.manager, { profiles }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change"); setValue(input(mounted.root, "kt-marginX"), "3");
  first.fs.operations = [];
  setValue(labels(mounted.root, "select", "预览设备"), second.id, "change"); await settle();
  expect(frame(mounted.root).getAttribute("width")).toBe("1264"); expect(first.fs.operations).toEqual([]);
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("3");
  expect(mounted.root.textContent).toContain("有未保存的修改");
});

it("keeps a manually chosen remembered preview target across probes and blocks sending from another device", async () => {
  const first = await paired(), second = await paired("kobo");
  await first.repo.put((await second.manager.remembered())[0]!);
  const mounted = mount(first.manager); await settle();
  setValue(labels(mounted.root, "select", "预览设备"), second.id, "change");
  await first.manager.probe(); await settle();
  expect(frame(mounted.root).getAttribute("width")).toBe("1264");
  expect((labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(second.id);
  expect(mounted.root.textContent).toContain("预览的是 我的 Libra，请切换到这台设备后发送。");
  expect((button(mounted.root, "发送到 我的 Paperwhite") as HTMLButtonElement).disabled).toBe(true);
});

it("switches to a reconnected device after a manual device choice", async () => {
  const first = await paired(), second = await paired("kobo");
  await first.repo.put((await second.manager.remembered())[0]!);
  const mounted = mount(first.manager); await settle();
  setValue(labels(mounted.root, "select", "预览设备"), second.id, "change"); await settle();
  expect((labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(second.id);
  first.fs.unplug(); await first.manager.probe(); await settle();
  first.fs.plug(); await first.manager.probe(); await settle();
  expect((labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(first.id);
  expect(frame(mounted.root).getAttribute("width")).toBe("1072");
});

it("switches a model-only preview to a different device that becomes granted", async () => {
  const first = await paired(), second = await paired("kobo"), reading = readingApi();
  await first.repo.put((await second.manager.remembered())[0]!);
  reading.store.set(`${second.id}:kobo`, { ...defaultReadingSettings("kobo"), profileId: "custom" });
  const mounted = mount(first.manager, { reading: reading.api }); await settle();
  setValue(labels(mounted.root, "select", "预览设备"), "", "change"); await settle();
  await first.manager.restore(second.id); await settle();
  expect((labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(second.id);
  expect(frame(mounted.root).getAttribute("width")).toBe("1264");
  expect((labels(mounted.root, "select", "方案") as HTMLSelectElement).value).toBe("custom");
});

it("keeps a dirty draft and offers to switch when a different device becomes granted", async () => {
  const first = await paired(), second = await paired("kobo");
  await first.repo.put((await second.manager.remembered())[0]!);
  const mounted = mount(first.manager); await settle();
  setValue(input(mounted.root, "kt-marginX"), "2.5");
  await first.manager.restore(second.id); await settle();
  expect((labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(first.id);
  expect(frame(mounted.root).getAttribute("width")).toBe("1072");
  const notice = button(mounted.root, "切换到 我的 Libra"); expect(notice).toBeDefined();
  fire(notice, "click"); await settle();
  expect((labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(second.id);
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("2.5");
});

it("does not let a restored but ungranted device override a manual choice", async () => {
  const first = await paired(), second = await paired("kobo");
  await first.repo.put((await second.manager.remembered())[0]!);
  const mounted = mount(first.manager); await settle();
  setValue(labels(mounted.root, "select", "预览设备"), first.id, "change");
  second.fs.permission = "prompt";
  await first.manager.restore(second.id); await settle();
  expect((labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(first.id);
  expect(frame(mounted.root).getAttribute("width")).toBe("1072");
});

it("selects each paired device's remembered profile and saves a manual choice only for that device", async () => {
  const first = await paired(), second = await paired("kobo"), reading = readingApi();
  await first.repo.put((await second.manager.remembered())[0]!);
  reading.store.set(`${first.id}:kindle`, { ...defaultReadingSettings("kindle"), profileId: "default" });
  reading.store.set(`${second.id}:kobo`, { ...defaultReadingSettings("kobo"), profileId: "custom" });
  const mounted = mount(first.manager, { reading: reading.api }); await settle();
  const deviceSelect = () => labels(mounted.root, "select", "预览设备") as HTMLSelectElement;
  const profileSelect = () => labels(mounted.root, "select", "方案") as HTMLSelectElement;
  expect(profileSelect().value).toBe("default");
  setValue(deviceSelect(), second.id, "change"); await settle();
  expect(profileSelect().value).toBe("custom");
  setValue(deviceSelect(), first.id, "change"); await settle();
  expect(profileSelect().value).toBe("default");
  setValue(deviceSelect(), second.id, "change"); await settle();
  setValue(profileSelect(), "default", "change");
  await new Promise(resolve => setTimeout(resolve, 560)); await settle();
  expect(reading.save).toHaveBeenLastCalledWith(second.id, "kobo", { margin: "min", profileId: "default" });
  setValue(deviceSelect(), first.id, "change"); await settle();
  expect(profileSelect().value).toBe("default");
  expect(reading.store.get(`${first.id}:kindle`)).toEqual({ margin: "narrow", profileId: "default" });
});

it("reads a device's deleted profile id as the default profile", async () => {
  const { manager, id } = await paired(), reading = readingApi();
  reading.store.set(`${id}:kindle`, { ...defaultReadingSettings("kindle"), profileId: "deleted-profile" });
  const mounted = mount(manager, { reading: reading.api }); await settle();
  expect((labels(mounted.root, "select", "方案") as HTMLSelectElement).value).toBe("default");
});

it("updates preview asset modes live and includes the strip toggles in reset, save and dirty state", async () => {
  const { manager } = await paired(), profiles = api(), onDirty = vi.fn(), mounted = mount(manager, { profiles, onDirty }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  const change = (label: string, checked: boolean) => { const node = button(mounted.root, label); if ((node.getAttribute("aria-pressed") === "true") !== checked) fire(node, "click"); ui.flush(); };
  for (const label of ["去掉书籍自带页边距", "去掉书籍自带行高", "去掉书籍自带段间距"]) expect(button(mounted.root, label)).toBeDefined();
  change("去掉书籍自带字体", true); expect(frame(mounted.root).getAttribute("src")).toContain("/devices/content/a/10000/epub/"); expect(onDirty).toHaveBeenLastCalledWith(true);
  change("去掉所有图片", true); expect(frame(mounted.root).getAttribute("src")).toContain("/devices/content/a/11000/epub/");
  change("去掉书籍自带页边距", true); expect(frame(mounted.root).getAttribute("src")).toContain("/devices/content/a/11100/epub/");
  change("去掉书籍自带行高", true); expect(frame(mounted.root).getAttribute("src")).toContain("/devices/content/a/11110/epub/");
  change("去掉书籍自带段间距", true); expect(frame(mounted.root).getAttribute("src")).toContain("/devices/content/a/11111/epub/");
  fire(button(mounted.root, "重置"), "click"); ui.flush(); expect(onDirty).toHaveBeenLastCalledWith(false); expect(frame(mounted.root).getAttribute("src")).toContain("/book/a/epub/");
  change("去掉所有图片", true); fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(profiles.update).toHaveBeenCalledWith(expect.objectContaining({ id: "custom", settings: expect.objectContaining({ stripImages: true }) }));
});

it("validates custom CSS, retains a failed draft and protects the save button", async () => {
  const { manager } = await paired(), profiles = api(), mounted = mount(manager, { profiles }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  setValue(labels(mounted.root, "textarea", "额外自定义 CSS"), "p {");
  expect(mounted.root.textContent).toContain("CSS 花括号不匹配"); expect((button(mounted.root, "保存方案") as HTMLButtonElement).disabled).toBe(true);
  setValue(labels(mounted.root, "textarea", "额外自定义 CSS"), "p { color: black; }");
  vi.mocked(profiles.update).mockRejectedValueOnce(new Error("数据库暂不可用")); fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(mounted.root.textContent).toContain("数据库暂不可用"); expect(mounted.root.textContent).toContain("有未保存的修改");
});

it("keeps a font-linked preview as an unsaved draft", async () => {
  const { manager } = await paired(), profiles = api(), mounted = mount(manager, { profiles, initialFont: "Book" }); await settle();
  expect(mounted.root.textContent).toContain("字体预览"); expect(mounted.root.textContent).toContain("有未保存的修改");
  expect(profiles.update).not.toHaveBeenCalled(); expect(profiles.create).not.toHaveBeenCalled();
});

it("picks the preview book from one searchable dropdown: open, type, Enter", async () => {
  const chapters = vi.fn(async () => [{ title: "第一章", item_path: "Text/第一 章.xhtml" }]);
  const mounted = mount(null, { chapters }); await settle();
  const box = bookBox(mounted.root), options = () => elements(mounted.root, "li").filter(node => node.getAttribute("role") === "option");
  expect(box.value).toBe("甲"); expect(box.getAttribute("aria-expanded")).toBe("false"); expect(options()).toHaveLength(0);
  fire(box, "focus"); ui.flush();
  expect(box.getAttribute("aria-expanded")).toBe("true"); expect(box.value).toBe(""); expect(box.getAttribute("placeholder")).toBe("甲 · 作者");
  expect(options().map(node => node.textContent)).toEqual(["甲 · 作者", "乙"]);
  setValue(box, "乙"); expect(options().map(node => node.textContent)).toEqual(["乙"]);
  fire(box, "keydown", { key: "Enter" }); ui.flush(); await settle();
  expect(chapters).toHaveBeenCalledWith("b"); expect(box.getAttribute("aria-expanded")).toBe("false"); expect(box.value).toBe("乙");
  // Arrow keys move the highlight; Escape closes without changing the book.
  fire(box, "keydown", { key: "ArrowDown" }); ui.flush(); expect(box.getAttribute("aria-expanded")).toBe("true");
  fire(box, "keydown", { key: "ArrowUp" }); ui.flush(); expect(box.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
  fire(box, "keydown", { key: "Escape" }); ui.flush(); expect(box.value).toBe("乙"); expect(chapters).toHaveBeenCalledTimes(1);
  setValue(box, "没有这本"); expect(mounted.root.textContent).toContain("没有匹配的书");
  fire(box, "keydown", { key: "Enter" }); ui.flush(); expect(chapters).toHaveBeenCalledTimes(1);
  // A click on an option picks it.
  fire(box, "blur"); ui.flush(); fire(box, "focus"); ui.flush(); fire(options()[0]!, "click"); ui.flush(); await settle();
  expect(chapters).toHaveBeenLastCalledWith("a"); expect(box.value).toBe("甲");
});

it("ignores a stale chapter response after the book changed", async () => {
  let finish!: (value: { title: string; item_path: string }[]) => void;
  const chapters = vi.fn((id: string) => id === "b" ? new Promise<{ title: string; item_path: string }[]>(resolve => { finish = resolve; }) : Promise.resolve([{ title: "新第一章", item_path: "new.xhtml" }]));
  const mounted = mount(null, { chapters }); await settle();
  setValue(labels(mounted.root, "select", "预览型号"), "KO3", "change"); expect(frame(mounted.root).getAttribute("width")).toBe("1264");
  pickBook(mounted.root, "乙"); pickBook(mounted.root, "甲"); await settle();
  finish([{ title: "过期第二章", item_path: "stale.xhtml" }]); await settle();
  expect(frame(mounted.root).getAttribute("src")).toBe("/book/a/epub/new.xhtml");
  expect(elements(mounted.root, "option").map(option => option.textContent)).not.toContain("过期第二章");
});

it("shows compact profile range rows, all strip toggles and advanced settings for an editable profile", async () => {
  const { manager, id } = await paired(), profiles = api();
  vi.mocked(profiles.list).mockImplementation(async () => [defaultProfile(), { ...custom(), settings: { ...EMPTY_SETTINGS } }]);
  const mounted = mount(manager, { profiles }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  const editor = withClass(mounted.root, "kt-editor");
  expect(elements(editor, "input").filter(node => node.getAttribute("type") === "range").map(node => node.getAttribute("aria-label"))).toEqual(["左右边距调整（%）", "行高"]);
  for (const [key, label, min, max, step, fallback] of [
    ["marginX", "左右边距调整（%）", "-10", "20", "0.1", "0"],
    ["lineHeight", "行高", "1.2", "2.4", "0.05", "1.6"],
  ]) {
    const slider = input(editor, `kt-${key}`), row = rangeRow(editor, `kt-${key}`), output = rangeOutput(editor, `kt-${key}`);
    expect(["aria-label", "min", "max", "step", "value"].map(attr => slider.getAttribute(attr))).toEqual([label, min, max, step, fallback]);
    expect(output.textContent).toBe(key === "marginX" ? "默认" : "书籍");
    const reset = button(row, key === "marginX" ? "恢复默认" : "恢复沿用书籍");
    expect(reset.hasAttribute("hidden")).toBe(true); expect(reset.hasAttribute("disabled")).toBe(true);
  }
  for (const label of ["段间距（em）", "首行缩进（em）"]) {
    expect(button(editor, `增大${label}`)).toBeDefined(); expect(button(editor, `减小${label}`)).toBeDefined();
  }
  const advanced = withClass(editor, "kt-advanced"), checkboxes = withClass(editor, "kt-checkboxes");
  expect(advanced.hasAttribute("open")).toBe(false);
  expect(labels(advanced, "textarea", "生成的 CSS（只读）").hasAttribute("readonly")).toBe(true);
  expect(elements(checkboxes, "legend")[0]!.textContent).toBe("去掉书里自带的");
  expect(elements(checkboxes, "button").map(node => node.getAttribute("aria-label"))).toEqual(["去掉书籍自带字体", "去掉所有图片", "去掉书籍自带页边距", "去掉书籍自带行高", "去掉书籍自带段间距"]);
  expect(elements(checkboxes, "button").every(node => node.getAttribute("aria-pressed") === "false")).toBe(true);
  expect(elements(labels(editor, "select", "字体（预览设备上已安装）"), "option")[0]!.textContent).toBe("设备默认字体");
  expect(elements(editor, "*").filter(node => /kt-font-(filter|field)/.test(node.getAttribute("class") || ""))).toEqual([]);
  expect(elements(withClass(editor, "kt-profile-actions"), "button").map(node => node.textContent)).toEqual(["还原", "删除", "另存为", "保存"]);
});

it("fits the frame to the smaller width/height constraint after mount, resize and panel changes, and releases layout listeners", async () => {
  const observers: LayoutObserver[] = [];
  class LayoutObserver {
    targets = new Set<Element>();
    disconnect = vi.fn(() => { this.targets.clear(); });
    constructor(readonly callback: () => void) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
  }
  const notify = (target: Element) => { for (const observer of observers) if (observer.targets.has(target)) observer.callback(); ui.flush(); };
  vi.stubGlobal("ResizeObserver", LayoutObserver);
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.mocked(window.matchMedia).mockReturnValue(media as unknown as MediaQueryList);
  let width = 720, height = 500;
  Object.assign(window, { innerHeight: 900 });
  const mounted = mount(null, {}, root => {
    const viewport = withClass(root, "kt-device-space"), preview = withClass(root, "kt-preview");
    Object.defineProperties(viewport, { clientWidth: { get: () => width }, clientHeight: { get: () => height } });
    Object.defineProperty(preview, "clientWidth", { value: 720 });
    expect(elements(root, "iframe")[0]!.getAttribute("style")).toContain("scale(0.4)");
  });
  await settle();
  const viewport = withClass(mounted.root, "kt-device-space"), preview = withClass(mounted.root, "kt-preview"), screen = frame(mounted.root) as HTMLIFrameElement;
  const scale = () => Number(/scale\(([^)]+)\)/.exec(screen.style.getPropertyValue("transform"))![1]);
  expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
  expect(scale()).toBeCloseTo((height - 80) / 1448);
  expect((preview as HTMLElement).getAttribute("style")).toBeNull();
  width = 260; height = 900; notify(viewport); expect(scale()).toBeCloseTo((width - 44) / 1072);
  width = 720; height = 300; notify(viewport); expect(scale()).toBeCloseTo((height - 80) / 1448);
  setValue(labels(mounted.root, "select", "预览型号"), "KO3", "change"); await settle();
  expect(scale()).toBeCloseTo((height - 80) / 1680);
  expect(screen.getAttribute("height")).toBe("1680");
  width = 400; height = 120; media.matches = false; media.dispatchEvent(new Event("change")); ui.flush();
  expect(scale()).toBeCloseTo((width - 44) / 1264);
  width = 1200; notify(viewport); expect(scale()).toBeCloseTo(640 / 1680);
  mounted.dispose();
  expect(observers).toHaveLength(1); expect(observers.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true);
});

it("hydrates preview with chapter URLs, device fonts, profile CSS and survives going offline", async () => {
  const { fs, manager } = await paired("kindle", ["Book-Regular.ttf"]), profiles = api();
  const mounted = mount(manager, { profiles }); await settle();
  expect(profiles.list).toHaveBeenCalledWith();
  expect(mounted.root.textContent).toContain("正文");
  expect(frame(mounted.root).getAttribute("src")).toBe("/book/a/epub/Text/%E7%AC%AC%E4%B8%80%20%E7%AB%A0.xhtml");
  expect(frame(mounted.root).getAttribute("width")).toBe("1072");
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  expect(elements(mounted.root, "option").map(option => option.textContent)).toContain("Book");
  setValue(input(mounted.root, "kt-marginX"), "2.5");
  expect((labels(mounted.root, "textarea", "生成的 CSS（只读）") as HTMLTextAreaElement).value).toContain("margin-left: 2.5% !important");
  fs.unplug(); await manager.probe(); await settle();
  expect((labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(manager.snapshot().device?.identity.id ?? "");
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("2.5");
  expect(frame(mounted.root).getAttribute("src")).toBe("/book/a/epub/Text/%E7%AC%AC%E4%B8%80%20%E7%AB%A0.xhtml");
});

it("edits and resets signed margins with compact values, previews calibrated counts and persists the device preset", async () => {
  const { manager, id } = await paired(), profiles = api(), reading = readingApi();
  let stored = custom();
  vi.mocked(profiles.list).mockImplementation(async () => [defaultProfile(), stored]);
  vi.mocked(profiles.update).mockImplementation(async value => { stored = { ...value, builtIn: false }; return stored; });
  const mounted = mount(manager, { profiles, reading: reading.api }); await settle();
  const estimate = () => elements(mounted.root, "p", "data-kindle-line-estimate")[0]!.textContent;
  expect(estimate()).toBe("预计每行约 16 字、每页 13 行（实测 · 1072×1448）");
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  const margin = input(mounted.root, "kt-marginX"), output = rangeOutput(mounted.root, "kt-marginX"), reset = button(rangeRow(mounted.root, "kt-marginX"), "恢复默认");
  expect(output.textContent).toBe("1%"); expect(reset.hasAttribute("hidden")).toBe(false);
  expect(margin.getAttribute("aria-label")).toBe("左右边距调整（%）"); expect(margin.getAttribute("min")).toBe("-10"); expect(margin.getAttribute("step")).toBe("0.1");
  fire(button(mounted.root, "恢复默认"), "click"); ui.flush();
  expect(estimate()).toContain("约 16 字"); expect(output.textContent).toBe("默认"); expect(reset.hasAttribute("hidden")).toBe(true);
  setValue(margin, "-4.8");
  expect((margin as HTMLInputElement).value).toBe("-4.8"); expect(estimate()).toContain("约 18 字");
  expect(output.textContent).toBe("-4.8%"); expect(reset.hasAttribute("hidden")).toBe(false);
  expect((labels(mounted.root, "textarea", "生成的 CSS（只读）") as HTMLTextAreaElement).value).toContain("margin-left: -4.8% !important");
  fire(button(mounted.root, "恢复默认"), "click"); ui.flush();
  setValue(labels(mounted.root, "select", "设备页边距"), "medium", "change"); expect(estimate()).toContain("约 14 字");
  setValue(labels(mounted.root, "select", "设备页边距"), "wide", "change"); expect(estimate()).toContain("约 11 字");
  expect(margin.getAttribute("min")).toBe("-10");
  await new Promise(resolve => setTimeout(resolve, 560)); await settle();
  expect(reading.save).toHaveBeenLastCalledWith(id, "kindle", expect.objectContaining({ margin: "wide" }));
  mounted.dispose();
  const reloaded = mount(manager, { profiles, reading: reading.api }); await settle();
  expect(button(labels(reloaded.root, "select", "设备页边距"), "宽").getAttribute("aria-pressed")).toBe("true");
  expect(elements(reloaded.root, "p", "data-kindle-line-estimate")[0]!.textContent).toContain("约 11 字");
});

it("shows one book-following value per compact range and hides each reset again after restoring null", async () => {
  const { manager } = await paired(), mounted = mount(manager); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  for (const [key, value, text] of [["lineHeight", "1.85", "1.85"], ["paragraphSpacing", "增大段间距（em）", "0.1em"], ["textIndent", "增大首行缩进（em）", "2.5em"]]) {
    const row = key === "lineHeight" ? rangeRow(mounted.root, `kt-${key}`) : controlRow(button(mounted.root, value!));
    const output = elements(withClass(row, "kt-range-value"), "output")[0]!, reset = button(row, "恢复沿用书籍");
    if (key === "lineHeight") setValue(input(mounted.root, `kt-${key}`), value!); else { fire(button(row, value!), "click"); ui.flush(); }
    expect(output.textContent).toBe(text); expect(output.className).not.toContain("is-inherited");
    expect(reset.getAttribute("title")).toBe("恢复沿用书籍"); expect(reset.textContent).toBe("↺");
    expect(reset.hasAttribute("hidden")).toBe(false); expect(reset.hasAttribute("disabled")).toBe(false);
    fire(reset, "click"); ui.flush();
    expect(output.textContent).toBe("书籍"); expect(output.className).toBe("is-inherited");
    expect(row.textContent).not.toContain("沿用书籍"); expect(reset.hasAttribute("hidden")).toBe(true); expect(reset.hasAttribute("disabled")).toBe(true);
  }
});

it("keeps a legacy em margin until edited, then switches the adjustment to percent", async () => {
  const { manager, id } = await paired(), profiles = api();
  let stored: TypesettingProfile = { ...custom(), settings: { ...custom().settings, marginX: 1, marginXUnit: "em" } };
  vi.mocked(profiles.list).mockImplementation(async () => [defaultProfile(), stored]);
  vi.mocked(profiles.update).mockImplementation(async value => { stored = { ...value, builtIn: false }; return stored; });
  const mounted = mount(manager, { profiles }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  const css = () => (labels(mounted.root, "textarea", "生成的 CSS（只读）") as HTMLTextAreaElement).value;
  const output = rangeOutput(mounted.root, "kt-marginX");
  expect(output.textContent).toBe("1em"); expect(output.getAttribute("title")).toContain("随字号缩放");
  expect(css()).toContain("margin-left: 1em !important");
  expect(Number((input(mounted.root, "kt-marginX") as HTMLInputElement).value)).toBeCloseTo(6); expect(mounted.root.textContent).not.toContain("有未保存的修改");
  setValue(input(mounted.root, "kt-marginX"), "-4.8");
  expect(output.textContent).toBe("-4.8%"); expect(output.hasAttribute("title")).toBe(false);
  expect(css()).toContain("margin-left: -4.8% !important");
  fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(stored.settings).toMatchObject({ marginX: -4.8, marginXUnit: "percent" });
});

it("keeps the saved profile selected after saving when the browser drops the re-rendered option", async () => {
  const { manager, id } = await paired(), profiles = api();
  let stored = custom();
  vi.mocked(profiles.list).mockImplementation(async () => [defaultProfile(), stored]);
  vi.mocked(profiles.update).mockImplementation(async value => { stored = { ...value, builtIn: false }; return stored; });
  const mounted = mount(manager, { profiles }); await settle();
  const profileSelect = () => labels(mounted.root, "select", "方案") as HTMLSelectElement;
  setValue(profileSelect(), "custom", "change"); setValue(input(mounted.root, "kt-lineHeight"), "1.8");
  fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(profiles.update).toHaveBeenCalledWith(expect.objectContaining({ id: "custom", settings: expect.objectContaining({ lineHeight: 1.8 }) }));
  profileSelect().value = "default";
  setValue(input(mounted.root, "kt-lineHeight"), "1.9");
  expect(profileSelect().value).toBe("custom"); expect(input(mounted.root, "kt-lineHeight")).toBeDefined();
});

it("accepts margins past the device edge, shows the overflow note and labels unmeasured panels as estimates", async () => {
  const { manager } = await paired(), mounted = mount(manager); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  setValue(input(mounted.root, "kt-marginX"), "-20");
  expect((button(mounted.root, "保存方案") as HTMLButtonElement).disabled).toBe(false);
  expect(mounted.root.textContent).toContain("左右边距超出设备自带边距，部分文字会被屏幕边缘切掉。");
  setValue(labels(mounted.root, "select", "预览设备"), "", "change");
  setValue(labels(mounted.root, "select", "设备种类"), "kobo", "change");
  setValue(labels(mounted.root, "select", "预览型号"), "nia", "change");
  expect(elements(mounted.root, "p", "data-kindle-line-estimate")[0]!.textContent).toContain("估算");
  expect(elements(mounted.root, "p", "data-kindle-line-estimate")[0]!.textContent).toContain("758×1024");
});

it("takes over a chapter already loaded before hydration and applies CSS and device fonts only inside its frame", async () => {
  const { manager, fs } = await paired("kindle", ["Book-Regular.ttf"]), { document: doc, head, fonts } = previewDocumentFixture(), appFonts = new Set<FontFace>();
  Object.defineProperty(document, "fonts", { value: appFonts, configurable: true });
  const bookStyle = doc.createElement("style"); bookStyle.textContent = "p { color: black; }"; head.appendChild(bookStyle);
  vi.stubGlobal("FontFace", class { load() { return Promise.resolve(this); } });
  const mounted = mount(manager, {}, root => { Object.defineProperty(frame(root), "contentDocument", { value: doc }); }); await settle();
  expect(elements(head, "style", "data-bindery-profile")).toHaveLength(1);
  expect(Array.from(head.childNodes).map(node => node.textContent)).toEqual([expect.stringContaining("font-size: 55px"), bookStyle.textContent, ""]);
  setValue(labels(mounted.root, "select", "设备页边距"), "medium", "change");
  expect(head.firstChild!.textContent).toContain("margin: 52px 137px 70px !important");
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  setValue(labels(mounted.root, "select", "字体（预览设备上已安装）"), "Book", "change"); await settle();
  expect(elements(head, "style", "data-bindery-profile")[0]!.textContent).toContain('font-family: "Book"');
  expect(bookStyle.textContent).toBe("p { color: black; }"); expect(fonts.size).toBe(1); expect(appFonts.size).toBe(0);
  setValue(labels(mounted.root, "textarea", "额外自定义 CSS"), "p {"); fs.unplug(); await manager.probe(); await settle(); expect(fonts.size).toBe(0);
  mounted.dispose(); expect(elements(head, "style", "data-bindery-profile")).toHaveLength(0); expect(bookStyle.parentNode).toBe(head);
});

it("hydrates neutral page controls in place and turns pages, chapter boundaries and selector resets", async () => {
  const bookData = { ...data, sections: [...data.sections, { title: "第二章", item_path: "Text/b.xhtml" }] };
  let current = previewDocumentFixture();
  let originalControls!: Element, originalScreen!: Element, originalButtons!: Element[];
  const mounted = mount(null, { data: bookData }, root => {
    originalControls = withClass(root, "kt-page-controls"); originalScreen = withClass(root, "kt-screen"); originalButtons = elements(originalControls, "button");
    expect(originalControls.textContent).toBe("上一页正在分页…下一页");
    expect(originalButtons.every(button => button.hasAttribute("disabled"))).toBe(true);
    expect(elements(originalControls, "span")[0]!.getAttribute("aria-live")).toBe("polite"); expect(originalScreen.getAttribute("tabindex")).toBe("0");
    Object.defineProperty(frame(root), "contentDocument", { configurable: true, get: () => current.document });
  });
  await settle();
  const { root } = mounted, status = () => elements(root, "span", "data-kindle-page-status")[0]!.textContent;
  const previous = () => button(root, "上一页") as HTMLButtonElement, next = () => button(root, "下一页") as HTMLButtonElement, iframe = frame(root);
  expect(withClass(root, "kt-page-controls")).toBe(originalControls); expect(withClass(root, "kt-screen")).toBe(originalScreen);
  expect(elements(originalControls, "button")).toEqual(originalButtons);
  expect(status()).toBe("第 1 / 3 页"); expect(previous().disabled).toBe(true); expect(next().disabled).toBe(false);
  fire(next(), "click"); ui.flush(); expect(status()).toBe("第 2 / 3 页");
  fire(originalScreen, "keydown", { key: "PageDown" }); ui.flush(); expect(status()).toBe("第 3 / 3 页");
  fire(next(), "click"); ui.flush();
  expect(iframe.getAttribute("src")).toBe("/book/a/epub/Text/b.xhtml"); expect(next().disabled).toBe(true);
  current = previewDocumentFixture("/book/a/epub/Text/b.xhtml"); current.setExtent(2 * 2144 - 80);
  fire(iframe, "load"); await settle(); expect(status()).toBe("第 1 / 2 页"); expect(previous().disabled).toBe(false);
  current.dispatch("keydown", { key: "ArrowRight" }); ui.flush(); expect(status()).toBe("第 2 / 2 页"); expect(next().disabled).toBe(true);
  current.dispatch("keydown", { key: "PageUp" }); ui.flush(); expect(status()).toBe("第 1 / 2 页");
  fire(previous(), "click"); ui.flush();
  current = previewDocumentFixture(); fire(iframe, "load"); await settle();
  expect(status()).toBe("第 3 / 3 页"); expect((labels(root, "select", "章节") as HTMLSelectElement).value).toBe("0");
  setValue(labels(root, "select", "章节"), "0", "change"); expect(status()).toBe("第 1 / 3 页");
  fire(originalScreen, "keydown", { key: "ArrowLeft" }); ui.flush(); expect(status()).toBe("第 1 / 3 页"); expect(previous().disabled).toBe(true);
  setValue(labels(root, "select", "章节"), "1", "change");
  current = previewDocumentFixture("/book/a/epub/Text/b.xhtml"); fire(iframe, "load"); await settle(); expect(status()).toBe("第 1 / 3 页");
  mounted.dispose(); expect(current.document.removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
});

it("guards profile switching and reset while keeping a dirty draft", async () => {
  const { manager } = await paired(), mounted = mount(manager); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change"); setValue(input(mounted.root, "kt-marginX"), "3");
  vi.mocked(window.confirm).mockReturnValue(false); setValue(labels(mounted.root, "select", "方案"), "default", "change");
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("3");
  expect((labels(mounted.root, "select", "方案") as HTMLSelectElement).value).toBe("custom");
  fire(button(mounted.root, "重置"), "click"); ui.flush(); expect(mounted.root.textContent).toContain("有未保存的修改");
  vi.mocked(window.confirm).mockReturnValue(true); fire(button(mounted.root, "重置"), "click"); ui.flush();
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("1");
});

it("supports a remembered Oasis without FSA permission and applies a font link to an unsaved preview copy", async () => {
  const { manager, fs } = await paired(), saved = (await manager.remembered())[0]!;
  saved.identity.model = "KO3"; fs.permission = "prompt"; await manager.restore(saved);
  const profiles = api(), mounted = mount(manager, { profiles, initialFont: "Book" }); await settle();
  expect((labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(manager.snapshot().device!.identity.id);
  expect(frame(mounted.root).getAttribute("width")).toBe("1264");
  expect(mounted.root.textContent).toContain("字体预览"); expect(mounted.root.textContent).toContain("有未保存的修改");
  expect(profiles.update).not.toHaveBeenCalled(); expect(profiles.create).not.toHaveBeenCalled();
});

it("chooses a remembered device's model and profiles without selecting or opening its handle", async () => {
  const { repo, fs, id } = await paired(); repo.devices.get(id)!.identity.model = "KO3";
  const manager = new DeviceManager(repo);
  const mounted = mount(manager); await settle(); fs.operations = [];
  setValue(labels(mounted.root, "select", "预览设备"), id, "change"); await settle();
  expect(frame(mounted.root).getAttribute("width")).toBe("1264");
  expect(mounted.props.profiles.list).toHaveBeenCalledWith(); expect(fs.operations).toEqual([]);
});

it("unsubscribes page listeners and ignores a profile response arriving after disposal", async () => {
  const { manager } = await paired(); let finish!: (profiles: TypesettingProfile[]) => void;
  const profiles = api(); vi.mocked(profiles.list).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const subscribe = vi.spyOn(manager, "subscribe"), mounted = mount(manager, { profiles }); await settle();
  expect(subscribe).toHaveBeenCalledTimes(1); mounted.dispose();
  finish([defaultProfile(), custom()]); await settle();
  expect(mounted.root.textContent).not.toContain("正文");
});
