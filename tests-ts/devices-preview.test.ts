import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
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
    const result = await build({ configFile: false, logLevel: "silent", plugins: [
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
async function paired(kind: DeviceKind = "kindle") {
  const fs = kind === "kobo" ? await fakeKobo() : await fakeKindle(), repo = new Handles(), manager = new DeviceManager(repo, async () => fs.root);
  await manager.pick(); await manager.pair(kind === "kobo" ? "libra2" : "KPW3", kind === "kobo" ? "我的 Libra" : "我的 Paperwhite");
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
function setValue(node: Element, value: string, type = "input") { (node as HTMLInputElement).value = value; fire(node, type); ui.flush(); }
const input = (root: Element, id: string) => elements(root, "input").find(element => element.id === id)!;
const labels = (root: Element, tag: string, label: string) => elements(root, "label").find(element => element.firstChild?.textContent === label)!.getElementsByTagName(tag)[0]!;
const withClass = (root: Element, name: string) => elements(root, "*").find(node => node.className.split(/\s+/).includes(name))!;
const frame = (root: Element) => elements(root, "iframe")[0]!;

it("renders one neutral page with both kinds available, no profile-owning device and the measured estimate", () => {
  const root = document.createElement("div"); root.innerHTML = ssr.markup(propsFor(null));
  expect(elements(root, "h2").map(node => node.textContent)).toContain("排版方案");
  expect(elements(root, "h3").map(node => node.textContent)).toContain("设备阅读设置（只用于预览）");
  expect(root.textContent).not.toContain("方案所属设备");
  expect(labels(root, "select", "预览设备")).toBeDefined(); expect(labels(root, "select", "方案")).toBeDefined();
  expect(labels(root, "select", "设备种类")).toBeDefined(); expect(labels(root, "select", "预览型号")).toBeDefined();
  expect(frame(root).getAttribute("width")).toBe("1072");
  expect(elements(root, "p", "data-kindle-line-estimate")[0]!.textContent).toContain("1072×1448");
  expect(elements(root, "p", "data-kindle-line-estimate")[0]!.textContent).toContain("实测");
});

it("switches the preview device between Kindle and Kobo and updates geometry and preset controls", async () => {
  const { manager, id } = await paired(), mounted = mount(manager); await settle();
  expect(frame(mounted.root).getAttribute("width")).toBe("1072");
  expect(labels(mounted.root, "select", "预览设备").getAttribute("value") ?? (labels(mounted.root, "select", "预览设备") as HTMLSelectElement).value).toBe(id);
  expect(elements(labels(mounted.root, "select", "设备页边距"), "option").map(option => option.textContent)).toEqual(["窄", "中", "宽"]);
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
  setValue(input(mounted.root, "kt-reading-scale"), "120");
  setValue(input(mounted.root, "kt-reading-line-height"), "1.8");
  await new Promise(resolve => setTimeout(resolve, 560)); await settle();
  expect(reading.save).toHaveBeenCalledWith(id, "kindle", { margin: "narrow", scale: 1.2, lineHeight: 1.8 });
  const calls = reading.save.mock.calls.length;
  setValue(labels(mounted.root, "select", "预览设备"), "", "change");
  setValue(labels(mounted.root, "select", "设备种类"), "kobo", "change");
  setValue(input(mounted.root, "kt-reading-scale"), "80");
  await new Promise(resolve => setTimeout(resolve, 560)); await settle();
  expect(reading.save).toHaveBeenCalledTimes(calls);
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
  expect(queue.enqueue).toHaveBeenLastCalledWith(expect.any(Object), "a", "custom", { settings: expect.objectContaining({ marginX: 2.5, marginXUnit: "percent" }), overwrite: true });
});

it("shows the overflow note without clamping or blocking a save", async () => {
  const { manager } = await paired(), mounted = mount(manager); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  setValue(input(mounted.root, "kt-marginX"), "-20");
  expect(mounted.root.textContent).toContain("左右边距超出设备自带边距，部分文字会被屏幕边缘切掉。");
  expect((button(mounted.root, "保存方案") as HTMLButtonElement).disabled).toBe(false);
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("-20");
});

it("keeps the built-in profile immutable and saves, updates and deletes a global custom profile", async () => {
  const { manager } = await paired(), profiles = api(), mounted = mount(manager, { profiles }); await settle();
  expect(elements(mounted.root, "input").some(node => node.id === "kt-marginX")).toBe(false);
  fire(button(mounted.root, "新建方案"), "click"); ui.flush();
  setValue(labels(mounted.root, "input", "新方案名称"), "大字正文");
  fire(elements(mounted.root, "form")[0]!, "submit"); await settle();
  expect(profiles.create).toHaveBeenCalledWith({ name: "大字正文", settings: EMPTY_SETTINGS });
  setValue(input(mounted.root, "kt-textIndent"), "2"); fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(profiles.update).toHaveBeenCalledWith(expect.objectContaining({ id: "new-profile", name: "大字正文", settings: expect.objectContaining({ textIndent: 2 }) }));
  expect(mounted.root.textContent).toContain("排版方案已保存，所有设备共用。");
  fire(button(mounted.root, "删除"), "click"); ui.flush();
  fire(button(elements(mounted.root, "dialog")[1]!, "确认"), "click"); await settle();
  expect(profiles.delete).toHaveBeenCalledWith("new-profile");
  expect(elements(mounted.root, "input").some(node => node.id === "kt-marginX")).toBe(false);
});

it("rejects an invalid font query without breaking the page", async () => {
  const { manager } = await paired(), mounted = mount(manager, { initialFont: "bad\nfont" }); await settle();
  expect(mounted.root.textContent).toContain("无效的字体名称");
  expect((button(mounted.root, "保存方案") as HTMLButtonElement).disabled).toBe(true);
  setValue(labels(mounted.root, "select", "字体（预览设备上已安装）"), "", "change");
  expect(mounted.root.textContent).not.toContain("无效的字体名称");
});

it("protects a dirty draft while changing the preview device", async () => {
  const first = await paired(), second = await paired("kobo"), profiles = api();
  await first.repo.put((await second.manager.remembered())[0]!);
  const mounted = mount(first.manager, { profiles }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change"); setValue(input(mounted.root, "kt-marginX"), "3");
  setValue(labels(mounted.root, "select", "预览设备"), second.id, "change");
  expect(frame(mounted.root).getAttribute("width")).toBe("1264");
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

it("updates preview asset modes live and includes the strip toggles in reset, save and dirty state", async () => {
  const { manager } = await paired(), profiles = api(), onDirty = vi.fn(), mounted = mount(manager, { profiles, onDirty }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  const toggle = (label: string) => elements(mounted.root, "label").find(node => node.textContent === label)!.getElementsByTagName("input")[0] as HTMLInputElement;
  const change = (label: string, checked: boolean) => { const node = toggle(label); node.checked = checked; fire(node, "change"); ui.flush(); };
  expect(elements(mounted.root, "label").some(node => node.textContent === "去掉书籍自带页边距")).toBe(true);
  change("去掉书籍自带字体", true); expect(frame(mounted.root).getAttribute("src")).toContain("/devices/content/a/10/epub/"); expect(onDirty).toHaveBeenLastCalledWith(true);
  change("去掉所有图片", true); expect(frame(mounted.root).getAttribute("src")).toContain("/devices/content/a/11/epub/");
  change("去掉书籍自带页边距", true); expect(frame(mounted.root).getAttribute("src")).toContain("/devices/content/a/111/epub/");
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

it("ignores a stale chapter response after the book changed", async () => {
  let finish!: (value: { title: string; item_path: string }[]) => void;
  const chapters = vi.fn((id: string) => id === "b" ? new Promise<{ title: string; item_path: string }[]>(resolve => { finish = resolve; }) : Promise.resolve([{ title: "新第一章", item_path: "new.xhtml" }]));
  const mounted = mount(null, { chapters }); await settle();
  const select = labels(mounted.root, "select", "预览书籍"); setValue(select, "b", "change"); setValue(select, "a", "change"); await settle();
  finish([{ title: "过期第二章", item_path: "stale.xhtml" }]); await settle();
  expect(frame(mounted.root).getAttribute("src")).toBe("/book/a/epub/new.xhtml");
  expect(elements(mounted.root, "option").map(option => option.textContent)).not.toContain("过期第二章");
});
