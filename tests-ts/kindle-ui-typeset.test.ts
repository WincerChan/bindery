import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { solidOptions } from "../scripts/solid-options";
import { KindleDeviceManager } from "../src/client/kindle/device";
import type { HandleRepository, RememberedDevice } from "../src/client/kindle/remembered";
import type { PreviewData } from "../src/features/devices/preview/model";
import type { KindleContextValue } from "../src/features/kindle/context";
import { clientDocument, elements, fire } from "./support/client-dom";
import { allByAttribute, byAttribute, byRole, byText } from "./support/queries";
import { FakeDirectory, FakeFile, fakeKindle } from "./support/fake-fs";
import { previewDocumentFixture } from "./support/kindle-preview-dom";

type Props = { manager: KindleDeviceManager | null; data: PreviewData; onPreview?: (font: string) => unknown };
type Mounted = { dispose: () => void; flush: () => void };
type Bundle = { flush: () => void; markup: (kind: string, props: Props) => string; mount: (root: HTMLElement, kind: string, props: Props) => Mounted; routedMarkup: (kind: string, props: Props) => Promise<string>; routedMount: (root: HTMLElement, kind: string, props: Props) => Promise<Mounted & { context(): KindleContextValue }>; manager: (repo: HandleRepository) => KindleDeviceManager };
let ui: Bundle, ssr: Bundle;
const directory = mkdtempSync(join(tmpdir(), "bindery-typeset-ui-")), disposers: (() => void)[] = [];
class Handles implements HandleRepository {
  devices = new Map<string, RememberedDevice>();
  async list() { return [...this.devices.values()]; }
  async put(device: RememberedDevice) { this.devices.set(device.id, device); }
  async remove(id: string) { this.devices.delete(id); }
}
// Valid SFNT header without a name table exercises the core's filename fallback.
const font = (name: string) => new File([new Uint8Array([...(name.endsWith(".otf") ? [79, 84, 84, 79] : [0, 1, 0, 0]), 0, 0, 0, 0, 0, 0, 0, 0])], name);
const data: PreviewData = { books: [{ id: "a", title: "甲", author: "作者" }, { id: "b", title: "乙", author: null }], bookId: "a", sections: [{ title: "第一章", item_path: "Text/第一 章.xhtml" }], error: "" };
function globals() {
  const page = clientDocument(), prototype = Object.getPrototypeOf(page.createElement("div"));
  page.addEventListener = vi.fn(); page.removeEventListener = vi.fn();
  const body = page.createElement("body"); body.dispatchEvent = vi.fn(() => true); Object.defineProperty(page, "body", { value: body, configurable: true });
  let focused: Element = body;
  Object.defineProperty(page, "activeElement", { configurable: true, get: () => focused });
  prototype.focus = function (this: Element) { focused = this; };
  vi.stubGlobal("showDirectoryPicker", vi.fn());
  vi.stubGlobal("scrollTo", vi.fn());
  // Only browser property reflection / style mutation needed by this slice; no layout emulation.
  for (const key of ["width", "height"]) Object.defineProperty(prototype, key, { configurable: true,
    get(this: Element) { return Number(this.getAttribute(key)); }, set(this: Element, value: number) { this.setAttribute(key, String(value)); },
  });
  for (const key of ["disabled", "hidden"]) Object.defineProperty(prototype, key, { configurable: true,
    get(this: Element) { return this.hasAttribute(key); }, set(this: Element, value: boolean) { if (value) this.setAttribute(key, ""); else this.removeAttribute(key); },
  });
  const styles = new WeakMap<Element, object>();
  Object.defineProperty(prototype, "style", { configurable: true, get(this: Element) {
    if (!styles.has(this)) {
      const values = new Map<string, string>();
      styles.set(this, { setProperty: (key: string, value: string) => { values.set(key, value); }, removeProperty: (key: string) => { values.delete(key); }, getPropertyValue: (key: string) => values.get(key) ?? "" });
    }
    return styles.get(this);
  } });
  vi.stubGlobal("document", page); vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { confirm: vi.fn(() => true), location: new URL("http://bindery.local/devices/preview"), matchMedia: vi.fn(() => Object.assign(new EventTarget(), { matches: false })) }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
}
beforeEach(globals);
beforeAll(async () => {
  globals();
  const entry = join(directory, "probe.tsx");
  writeFileSync(entry, `
    import { hydrate, renderToString, isServer } from "@solidjs/web";
    import { Loading, flush } from "solid-js";
    import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from "@tanstack/solid-router";
    import { FontsPage } from ${JSON.stringify(resolve("src/features/kindle/typeset/fonts-page.tsx"))};
    import { KindleProvider, useKindle } from ${JSON.stringify(resolve("src/features/kindle/context.tsx"))};
    import { KindleDeviceBar } from ${JSON.stringify(resolve("src/features/kindle/device-bar.tsx"))};
    import { KindleTabs } from ${JSON.stringify(resolve("src/features/kindle/tabs.tsx"))};
    import { KindleDeviceManager } from ${JSON.stringify(resolve("src/client/kindle/device.ts"))};
    import { Route as FontsRoute } from ${JSON.stringify(resolve("src/routes/_app.devices.fonts.tsx"))};
    export const manager = repo => new KindleDeviceManager(repo);
    function view(kind, props) { return <FontsPage manager={props.manager} onPreview={props.onPreview} />; }
    export function markup(kind, props) { return renderToString(() => <Loading>{view(kind, props)}</Loading>); }
    export function mount(root, kind, props) { return { dispose: hydrate(() => <Loading>{view(kind, props)}</Loading>, root), flush }; }
    function routes(kind, props) {
      let context;
      function Capture() { context = useKindle(); return null; }
      const root = createRootRoute();
      const layout = createRoute({ getParentRoute: () => root, path: '/devices', component: () => <KindleProvider manager={props.manager} queue={{ snapshot: () => [], subscribe: () => () => {} }}><Capture /><div class="kindle-page"><KindleDeviceBar /><KindleTabs /><Outlet /></div></KindleProvider> });
      const page = FontsRoute.update({ getParentRoute: () => layout, path: kind, loader: async () => props.data });
      return { router: createRouter({ routeTree: root.addChildren([layout.addChildren([page])]), history: createMemoryHistory({ initialEntries: ['/devices/' + kind] }), isServer, origin: 'http://bindery.local' }), context: () => context };
    }
    export async function routedMarkup(kind, props) { const { router } = routes(kind, props); await router.load(); return renderToString(() => <Loading><RouterProvider router={router} /></Loading>); }
    export async function routedMount(root, kind, props) { const { router, context } = routes(kind, props); await router.load(); return { dispose: hydrate(() => <Loading><RouterProvider router={router} /></Loading>, root), flush, context }; }
    export { flush };
  `);
  for (const server of [false, true]) {
    const result = await build({ configFile: false, logLevel: "silent", plugins: [
      // Exercise the real route components, injecting only the server RPC boundary.
      { name: "kindle-ui-rpc-boundary", enforce: "pre", resolveId(id, importer) {
        if (!importer) return;
        if (id.includes("server/typeset/functions")) return "\0kindle-ui-profiles";
        if (id.endsWith("/server/functions")) return "\0kindle-ui-auth";
        if (id.endsWith("/typeset/preview.server")) return "\0kindle-ui-preview";
        if (id === "@tanstack/solid-start") return "\0kindle-ui-start";
      }, load(id) {
        if (id === "\0kindle-ui-profiles") return `
          export const listTypesetProfiles = ({ data }) => globalThis.__kindleProfiles.list(data);
          export const createTypesetProfile = ({ data }) => globalThis.__kindleProfiles.create(data);
          export const updateTypesetProfile = ({ data }) => globalThis.__kindleProfiles.update(data);
          export const deleteTypesetProfile = ({ data }) => globalThis.__kindleProfiles.delete(undefined, data.id);
        `;
        if (id === "\0kindle-ui-auth") return "export const authenticated = {}";
        if (id === "\0kindle-ui-preview") return "export const previewData = () => { throw Error('unexpected preview RPC') }; export const previewChapters = previewData;";
        if (id === "\0kindle-ui-start") return "export function createServerFn() { const chain = { middleware: () => chain, validator: () => chain, handler: () => () => { throw Error('unexpected server RPC') } }; return chain; }";
      } },
      solid(solidOptions),
    ],
      resolve: { dedupe: ["solid-js", "@solidjs/web", "@tanstack/solid-router"], conditions: server ? ["node", "production"] : ["browser", "production"] },
      define: { "process.env.NODE_ENV": JSON.stringify("production") }, ssr: { noExternal: true },
      build: { write: false, minify: true, ...(server ? { ssr: entry } : { lib: { entry, formats: ["es" as const] } }), rollupOptions: { output: { inlineDynamicImports: true } } },
    });
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(chunk => chunk.type === "chunk" && chunk.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing page probe");
    expect(chunk.imports.filter(id => !server || !["node:module", "module"].includes(id))).toEqual([]);
    const path = join(directory, server ? "server.mjs" : "client.mjs"); writeFileSync(path, chunk.code);
    const module = await import(/* @vite-ignore */ pathToFileURL(path).href) as Bundle;
    if (server) ssr = module; else ui = module;
  }
});
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.flush(); } };
const waitUi = (check: () => void) => vi.waitFor(() => { ui.flush(); check(); }, { interval: 1, timeout: 1000 });
async function paired(files: string[] = []) {
  const fs = await fakeKindle(), repo = new Handles(), manager = new KindleDeviceManager(repo, async () => fs.root);
  await manager.pick(); await manager.pair("KPW3", "我的 Paperwhite");
  for (const name of files) await fs.write(`fonts/${name}`, new Uint8Array(await font(name).arrayBuffer()));
  return { fs, repo, manager, id: manager.snapshot().device!.identity.id };
}
function mount(kind: string, manager: KindleDeviceManager | null, extra: Partial<Props> = {}, prepare?: (root: Element) => void) {
  const props: Props = { manager, data, ...extra };
  const root = document.createElement("div"); root.innerHTML = ssr.markup(kind, props); document.documentElement.appendChild(root);
  if (kind === "fonts") expect(root.textContent).toContain("检测中…");
  prepare?.(root);
  vi.stubGlobal("_$HY", { r: {}, completed: new WeakSet(), events: [] });
  const mounted = ui.mount(root as HTMLElement, kind, props); disposers.push(() => root.remove(), mounted.dispose);
  return { root, props, ...mounted };
}
const button = (root: Element, text: string) => elements(root, "button").find(element => element.textContent === text || element.getAttribute("aria-label") === text)!;
function setValue(node: Element, value: string, type = "input") { (node as HTMLInputElement).value = value; fire(node, type); ui.flush(); }
it("renders the fonts summary, actions, five scoped columns and installation help without a redundant title in SSR", () => {
  const root = document.createElement("div"); root.innerHTML = ssr.markup("fonts", { manager: null, data });
  const summary = byText(root, "0 个家族 · 0 个字体文件 · 0 B");
  expect(summary.textContent).not.toContain("设备根目录"); expect(summary.textContent).not.toContain("已忽略");
  for (const name of ["全部", "中文", "英文", "重新扫描", "添加字体"]) expect(byRole(root, "button", name)).toBeDefined();
  const table = byRole(byRole(root, "region", "字体列表"), "table");
  expect(elements(table, "th").map(node => node.textContent)).toEqual(["家族", "样张", "字重 / 样式", "大小", "操作"]);
  for (const cell of elements(table, "th")) expect(cell.getAttribute("scope")).toBe("col");
  const help = byRole(root, "region", "添加字体");
  expect(byRole(help, "heading", "添加字体")).toBeDefined();
});

async function mountRouted(kind: string, manager: KindleDeviceManager, extra: Partial<Props> = {}) {
  const props: Props = { manager, data, ...extra };
  const root = document.createElement("div"); root.innerHTML = await ssr.routedMarkup(kind, props); document.documentElement.appendChild(root);
  const bar = byAttribute(root, "data-kindle-device-bar");
  expect(bar.textContent).toContain("检测中…");
  const attributes = () => elements(root, "*").map(element => Array.from(element.attributes)
    .filter(attribute => attribute.name !== "_hk").map(attribute => [attribute.name, attribute.value]).sort());
  const ssrText = root.textContent, ssrNodes = elements(root, "*"), ssrAttributes = attributes();
  let firstRender: { text: string | null; nodes: Element[]; attributes: string[][][] } | undefined;
  const subscribe = manager.subscribe, listeners = new Set<Parameters<KindleDeviceManager["subscribe"]>[0]>();
  vi.spyOn(manager, "subscribe").mockImplementation(listener => {
    firstRender ??= { text: root.textContent, nodes: elements(root, "*"), attributes: attributes() };
    listeners.add(listener); const stop = subscribe(listener);
    return () => { listeners.delete(listener); stop(); };
  });
  vi.stubGlobal("_$HY", { r: {}, completed: new WeakSet(), events: [] });
  const mounted = await ui.routedMount(root as HTMLElement, kind, props); disposers.push(() => root.remove(), mounted.dispose);
  // Before the first external subscription, the client must claim exactly the SSR tree.
  expect(firstRender?.text).toBe(ssrText); expect(firstRender?.nodes).toEqual(ssrNodes);
  expect(firstRender?.attributes).toEqual(ssrAttributes);
  return { root, bar, props, ...mounted, heartbeat(now: number) { for (const listener of listeners) listener({ ...manager.snapshot(), now }); } };
}

it("preserves a selected OTF across probes, installs it on an empty device and refreshes shared usage after install/delete", async () => {
  const { fs, repo } = await paired(), manager = ui.manager(repo), mounted = await mountRouted("fonts", manager);
  await settle();
  expect(mounted.root.textContent).toContain("设备 fonts/ 目录中还没有可用字体");
  chooseFiles(mounted.root, [font("Routed-Regular.otf")]); await settle();
  expect(mounted.root.textContent).toContain("将安装到 我的 Paperwhite");
  await expect(fs.bytes("fonts/Routed-Regular.otf")).rejects.toMatchObject({ name: "NotFoundError" });
  fs.operations = [];
  window.dispatchEvent(new Event("focus")); await manager.probe(); await settle();
  expect(fs.operations.filter(op => op.operation === "values" && op.path === "/fonts")).toEqual([]);
  expect(mounted.root.textContent).toContain("将安装到 我的 Paperwhite");
  fire(button(mounted.root, "确认安装"), "click");
  await waitUi(() => {
    expect(allByAttribute(mounted.root, "data-font-family").map(row => row.getAttribute("data-font-family"))).toEqual(["Routed"]);
    expect(mounted.root.textContent).toContain("已安装 1 个字体文件");
    expect(mounted.root.textContent).not.toContain("正在读取或更新设备字体");
    expect(mounted.bar.textContent).toContain("字体 12 B");
  });
  expect(await fs.bytes("fonts/Routed-Regular.otf")).toEqual(new Uint8Array(await font("Routed-Regular.otf").arrayBuffer()));
  fire(button(mounted.root, "从设备删除 Routed"), "click"); ui.flush(); fire(button(mounted.root, "删除整个家族"), "click");
  await waitUi(() => { expect(mounted.bar.textContent).toContain("字体 0 B"); expect(allByAttribute(mounted.root, "data-font-family")).toHaveLength(0); });
  await expect(fs.bytes("fonts/Routed-Regular.otf")).rejects.toMatchObject({ name: "NotFoundError" });
});

it("finishes slow inventory reads without queuing new font scans for monitoring heartbeats", async () => {
  const { fs, repo } = await paired(), manager = ui.manager(repo);
  await manager.restore((await repo.list())[0]!);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), values = FakeDirectory.prototype.values;
  vi.spyOn(FakeDirectory.prototype, "values").mockImplementation(async function* (this: FakeDirectory) {
    if (this.name === "fonts") await gate;
    yield* values.call(this);
  });
  try {
    const mounted = await mountRouted("fonts", manager); await settle();
    expect(mounted.root.textContent).toContain("正在读取或更新设备字体");
    expect(mounted.context().inventoryBusy()).toBe(true);
    chooseFiles(mounted.root, [font("DuringScan-Regular.otf")]); await settle();
    expect(mounted.root.textContent).toContain("将安装到 我的 Paperwhite");
    expect((button(mounted.root, "确认安装") as HTMLButtonElement).disabled).toBe(true);
    // startMonitoring emits fresh DeviceState objects with `now` before each probe.
    // Keep the real shared device lock busy while these notifications arrive.
    for (let i = 1; i <= 3; i++) {
      mounted.heartbeat(Date.now() + i);
      ui.flush();
    }
    release();
    await waitUi(() => {
      expect(mounted.context().inventoryBusy()).toBe(false);
      expect(mounted.root.textContent).toContain("设备 fonts/ 目录中还没有可用字体");
      expect(mounted.root.textContent).not.toContain("正在读取或更新设备字体");
    });
    await settle();
    // One inventory per owner; each enumerates fonts for metadata and byte usage.
    expect(fs.operations.filter(op => op.operation === "values" && op.path === "/fonts")).toHaveLength(4);
    expect(mounted.root.textContent).toContain("将安装到 我的 Paperwhite");
    expect((button(mounted.root, "确认安装") as HTMLButtonElement).disabled).toBe(false);
    fire(button(mounted.root, "确认安装"), "click");
    await waitUi(() => { expect(mounted.bar.textContent).toContain("字体 12 B"); expect(mounted.root.textContent).not.toContain("正在读取或更新设备字体"); });
    expect(await fs.bytes("fonts/DuringScan-Regular.otf")).toHaveLength(12);
  } finally { release(); await settle(); }
});

it("hydrates neutral fonts markup, scans after mount, clears after unplug and reuses the handle after replug", async () => {
  const { fs, manager } = await paired(["Book-Regular.ttf", "Book-Light.otf", "Book-Bold.ttf"]);
  await fs.write("fonts/._Book.ttf", "ignore"); await fs.write("fonts/Readme.txt", "keep");
  const mounted = mount("fonts", manager); await settle();
  expect(allByAttribute(mounted.root, "data-font-family")).toHaveLength(1);
  expect(mounted.root.textContent).toContain("Light"); expect(mounted.root.textContent).toContain("手动安装");
  const sample = elements(mounted.root, "iframe")[0]!; expect(sample.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(elements(mounted.root, "a").find(a => a.getAttribute("aria-label") === "用 Book 预览")!.getAttribute("href")).toBe("/devices/preview?font=Book");
  expect(byRole(mounted.root, "button", "从设备删除 Book")).toBeDefined();
  fs.unplug(); await manager.probe(); await settle(); expect(allByAttribute(mounted.root, "data-font-family")).toHaveLength(0);
  expect(mounted.root.textContent).toContain("请连接并授权");
  fs.plug(); await manager.probe(); await settle(); expect(allByAttribute(mounted.root, "data-font-family")).toHaveLength(1);
});

it("navigates the preview action within the SPA while retaining a real font-specific link", async () => {
  const { manager } = await paired(["Book-Regular.ttf"]), onPreview = vi.fn();
  const mounted = mount("fonts", manager, { onPreview }); await settle();
  const link = elements(mounted.root, "a").find(anchor => anchor.getAttribute("aria-label") === "用 Book 预览")!;
  expect(link.getAttribute("href")).toBe("/devices/preview?font=Book"); fire(link, "click");
  expect(onPreview).toHaveBeenCalledWith("Book");
});

function chooseFiles(root: Element, files: File[]) {
  const element = elements(root, "input").find(input => input.getAttribute("type") === "file") as HTMLInputElement;
  Object.defineProperty(element, "files", { value: files, configurable: true }); fire(element, "change"); ui.flush();
}

function pauseFontWrites(names: string[]) {
  const original = FakeFile.prototype.createWritable;
  const pending: { filename: string; operation: "write" | "close"; release: () => void }[] = [];
  let stopped = false;
  vi.spyOn(FakeFile.prototype, "createWritable").mockImplementation(async function (this: FakeFile) {
    const stream = await original.call(this);
    if (!names.includes(this.name)) return stream;
    const wait = (operation: "write" | "close") => stopped ? Promise.resolve() : new Promise<void>(release => pending.push({ filename: this.name, operation, release }));
    return {
      write: async bytes => { await wait("write"); await stream.write(bytes); },
      close: async () => { await wait("close"); await stream.close(); },
      abort: () => stream.abort(),
    };
  });
  const stop = () => { stopped = true; pending.splice(0).forEach(item => item.release()); };
  disposers.push(stop);
  return { pending, stop, async release(filename: string, operation: "write" | "close" = "write") {
    await waitUi(() => expect(pending.map(item => [item.filename, item.operation])).toEqual([[filename, operation]]));
    pending.shift()!.release(); await settle();
  } };
}
const largeFont = async (name: string, megabytes: number) => new File([await font(name).arrayBuffer(), new Uint8Array(megabytes * 1024 * 1024 - 12)], name);

it.each([false, true])("hydrates the fonts route in place and shows stable, accessible file writes through batch commit (already connected=%s)", async alreadyConnected => {
  const { fs, repo } = await paired(), manager = ui.manager(repo);
  if (alreadyConnected) await manager.restore((await repo.list())[0]!);
  const mounted = await mountRouted("fonts", manager); await settle();
  const files = [await largeFont("CJK-Regular.ttf", 3), await largeFont("CJK-Bold.otf", 2)], gate = pauseFontWrites(files.map(file => file.name));
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  chooseFiles(mounted.root, files); await settle(); fire(button(mounted.root, "确认安装"), "click"); await settle();
  const rows = allByAttribute(mounted.root, "data-font-install-file"), bars = elements(mounted.root, "progress");
  const queue = byRole(mounted.root, "region", "字体安装进度");
  const cancel = button(queue, "取消字体安装"), live = allByAttribute(queue, "aria-live");
  const announcements = live.map(node => node.textContent), children = live.map(node => Array.from(node.childNodes));
  const summary = () => byAttribute(queue, "data-font-install-summary").textContent;
  expect(rows.map(row => row.getAttribute("data-font-install-file"))).toEqual(files.map(file => file.name));
  expect(rows.map(row => byText(row, /^(写入|等待)$/).textContent)).toEqual(["写入", "等待"]);
  expect(rows[0]!.textContent).toContain("3.0 MB"); expect(rows[1]!.textContent).toContain("2.0 MB");
  expect(bars.map(bar => bar.getAttribute("max"))).toEqual(files.map(file => String(file.size)));
  expect(bars.map(bar => bar.getAttribute("value"))).toEqual(["0", "0"]);
  expect(bars.map(bar => bar.getAttribute("aria-label"))).toEqual(files.map(file => `${file.name} 安装进度`));
  expect(live).toHaveLength(3); expect(live.every(node => node.getAttribute("aria-live") === "polite" && node.getAttribute("aria-atomic") === "true")).toBe(true);
  expect(summary()).toContain("共 2 个文件 · 已完成 0 · 已写入 0.0 / 5.0 MB");
  expect(document.activeElement).toBe(cancel);
  const otherControl = elements(mounted.root, "a")[0]! as HTMLElement;
  for (let chunk = 1; chunk <= 2; chunk++) {
    if (chunk === 2) otherControl.focus();
    now += 120; await gate.release(files[0]!.name);
    expect(bars[0]!.getAttribute("value")).toBe(String(chunk * 1024 * 1024));
    expect(bars[0]!.getAttribute("aria-valuetext")).toContain("MB/s · 剩余约");
    expect(summary()).toContain(`已写入 ${chunk}.0 / 5.0 MB`); expect(summary()).toContain("MB/s · 剩余约");
    expect(live.map(node => node.textContent)).toEqual(announcements);
    expect(live.map(node => Array.from(node.childNodes))).toEqual(children);
    expect(allByAttribute(queue, "data-font-install-file")).toEqual(rows); expect(elements(queue, "progress")).toEqual(bars);
    expect(document.activeElement).toBe(chunk === 1 ? cancel : otherControl);
    mounted.heartbeat(Date.now()); ui.flush(); expect(button(mounted.root, "确认安装")).toBeDefined();
  }
  (cancel as HTMLButtonElement).focus();
  now += 120; await gate.release(files[0]!.name);
  expect(bars[0]!.getAttribute("value")).toBe(String(files[0]!.size));
  expect(live[1]!.textContent).toContain("正在提交字体文件"); expect(summary()).toContain("已完成 0");
  expect(mounted.root.textContent).not.toContain("已安装 2 个字体文件");
  await gate.release(files[0]!.name, "close");
  expect(rows.map(row => byText(row, "写入").textContent)).toEqual(["写入", "写入"]);
  expect(live[1]!.textContent).toContain("等待批次提交");
  for (let chunk = 1; chunk <= 2; chunk++) { now += 120; await gate.release(files[1]!.name); }
  expect(summary()).toContain("已完成 0 · 已写入 5.0 / 5.0 MB");
  expect(mounted.root.textContent).not.toContain("已安装 2 个字体文件");
  await gate.release(files[1]!.name, "close");
  await waitUi(() => expect(mounted.root.textContent).toContain("已安装 2 个字体文件"));
  expect(summary()).toContain("共 2 个文件 · 已完成 2 · 已写入 5.0 / 5.0 MB");
  expect(rows.every(row => byText(row, "完成"))).toBe(true);
  expect(live.slice(1).every(node => node.textContent!.includes("字体文件安装完成"))).toBe(true);
  expect(cancel.getAttribute("aria-disabled")).toBe("true"); expect(document.activeElement).toBe(cancel);
  expect(allByAttribute(queue, "data-font-install-file")).toEqual(rows); expect(elements(queue, "progress")).toEqual(bars);
  expect(mounted.bar.textContent).toContain("字体 5 MB");
  for (const file of files) expect(Buffer.from(await fs.bytes(`fonts/${file.name}`)).equals(new Uint8Array(await file.arrayBuffer()))).toBe(true);
});

it("cancels a font batch from the progress controls, announces rollback and preserves focus and existing files", async () => {
  const { fs, manager } = await paired(["Keep-Regular.ttf"]), mounted = mount("fonts", manager); await settle();
  const files = [font("First.ttf"), await largeFont("Second.otf", 2)], gate = pauseFontWrites(files.map(file => file.name));
  chooseFiles(mounted.root, files); await settle(); fire(button(mounted.root, "确认安装"), "click"); await settle();
  await gate.release("First.ttf"); await gate.release("First.ttf", "close");
  expect(await fs.bytes("fonts/First.ttf")).toHaveLength(12);
  const cancel = button(mounted.root, "取消字体安装"), rows = allByAttribute(mounted.root, "data-font-install-file");
  fire(cancel, "click"); ui.flush();
  expect(mounted.root.textContent).toContain("正在取消字体安装，等待回滚"); expect(cancel.getAttribute("aria-disabled")).toBe("true");
  await gate.release("Second.otf");
  await waitUi(() => expect(elements(mounted.root, "p").find(node => node.getAttribute("role") === "alert")?.textContent).toBe("操作已取消"));
  expect(rows.map(row => byText(row, "失败").textContent)).toEqual(["失败", "失败"]);
  expect(byAttribute(mounted.root, "data-font-install-summary").textContent).toContain("已完成 0");
  expect(mounted.root.textContent).not.toContain("已安装 2 个字体文件"); expect(document.activeElement).toBe(cancel);
  expect(allByAttribute(mounted.root, "data-font-family").map(row => row.getAttribute("data-font-family"))).toEqual(["Keep"]);
  for (const file of files) await expect(fs.bytes(`fonts/${file.name}`)).rejects.toMatchObject({ name: "NotFoundError" });
  await expect(fs.bytes(".bindery/pending.json")).rejects.toMatchObject({ name: "NotFoundError" });
  expect(await fs.bytes("fonts/Keep-Regular.ttf")).toHaveLength(12);
  expect((button(mounted.root, "确认安装") as HTMLButtonElement).disabled).toBe(false);
});

it("shows disconnect errors during a font write without success and recovers before rescanning after reconnect", async () => {
  const { fs, manager } = await paired(["Keep-Regular.ttf"]), mounted = mount("fonts", manager); await settle();
  const files = [font("First.ttf"), await largeFont("Second.otf", 2)], gate = pauseFontWrites(files.map(file => file.name));
  chooseFiles(mounted.root, files); await settle(); fire(button(mounted.root, "确认安装"), "click"); await settle();
  await gate.release("First.ttf"); await gate.release("First.ttf", "close");
  fs.unplug(); await manager.probe(); await settle();
  await gate.release("Second.otf");
  await waitUi(() => expect(elements(mounted.root, "p").find(node => node.getAttribute("role") === "alert")?.textContent).toContain("Kindle 已断开"));
  expect(mounted.root.textContent).not.toContain("已安装 2 个字体文件");
  expect(allByAttribute(mounted.root, "data-font-install-file").every(row => byText(row, "失败"))).toBe(true);
  fs.plug(); await manager.probe(); await settle();
  expect(allByAttribute(mounted.root, "data-font-family").map(row => row.getAttribute("data-font-family"))).toEqual(["Keep"]);
  for (const file of files) await expect(fs.bytes(`fonts/${file.name}`)).rejects.toMatchObject({ name: "NotFoundError" });
  await expect(fs.bytes(".bindery/pending.json")).rejects.toMatchObject({ name: "NotFoundError" });
});

it("shows a Windows long-path error with failed file rows and no installed notice", async () => {
  const { fs, manager } = await paired(), mounted = mount("fonts", manager); await settle();
  chooseFiles(mounted.root, [font("Short.ttf"), font(`${"字".repeat(250)}.ttf`)]); await settle();
  fire(button(mounted.root, "确认安装"), "click"); await settle();
  expect(elements(mounted.root, "p").find(node => node.getAttribute("role") === "alert")?.textContent).toContain("文件路径不适用于 Windows");
  expect(allByAttribute(mounted.root, "data-font-install-file").every(row => byText(row, "失败"))).toBe(true);
  expect(mounted.root.textContent).not.toContain("已安装 2 个字体文件");
  await expect(fs.bytes("fonts/Short.ttf")).rejects.toMatchObject({ name: "NotFoundError" });
});

it("shows an inspected family batch before installation, writes only after confirmation, and rescans", async () => {
  const { fs, manager } = await paired(), mounted = mount("fonts", manager); await settle();
  chooseFiles(mounted.root, [font("Sample-Regular.ttf"), font("Sample-Medium.otf")]); await settle();
  expect(mounted.root.textContent).toContain("将安装到 我的 Paperwhite"); expect(mounted.root.textContent).toContain("Sample-Medium.otf");
  await expect(fs.bytes("fonts/Sample-Regular.ttf")).rejects.toMatchObject({ name: "NotFoundError" });
  fire(button(mounted.root, "确认安装"), "click"); await settle();
  expect(await fs.bytes("fonts/Sample-Regular.ttf")).toHaveLength(12); expect(allByAttribute(mounted.root, "data-font-family")).toHaveLength(1);
  expect(mounted.root.textContent).toContain("已安装 2 个字体文件"); expect(mounted.root.textContent).toContain("Medium");
});

it("accepts a page drop through the same inspected confirmation flow as the file picker", async () => {
  const { manager, fs } = await paired(), listeners = new WeakMap<Element, Map<string, EventListener>>();
  const prototype = Object.getPrototypeOf(document.createElement("div")), original = prototype.addEventListener;
  prototype.addEventListener = function (this: Element, type: string, listener: EventListener) {
    if (!listeners.has(this)) listeners.set(this, new Map()); listeners.get(this)!.set(type, listener);
    original.call(this, type, listener);
  };
  try {
    const mounted = mount("fonts", manager); await settle();
    const page = byRole(mounted.root, "region", "字体管理");
    const preventDefault = vi.fn();
    listeners.get(page)!.get("drop")!.call(page, { currentTarget: page, preventDefault, dataTransfer: { files: [font("Dropped-Regular.otf")] } } as unknown as Event);
    await settle(); expect(preventDefault).toHaveBeenCalled(); expect(mounted.root.textContent).toContain("Dropped-Regular.otf");
    await expect(fs.bytes("fonts/Dropped-Regular.otf")).rejects.toMatchObject({ name: "NotFoundError" });
    fire(button(mounted.root, "确认安装"), "click"); await settle(); expect(await fs.bytes("fonts/Dropped-Regular.otf")).toHaveLength(12);
  } finally { prototype.addEventListener = original; }
});

it("rejects invalid and duplicate batches, preserves existing files on conflict, and clears a pending install after unplug", async () => {
  const { manager, fs } = await paired(["Book-Regular.ttf"]), mounted = mount("fonts", manager); await settle();
  chooseFiles(mounted.root, [font("a.ttf"), new File(["x"], "b.woff")]); await settle(); expect(mounted.root.textContent).toContain("只支持 TTF 和 OTF");
  chooseFiles(mounted.root, [font("same.ttf"), font("SAME.TTF")]); await settle(); expect(mounted.root.textContent).toContain("重复的字体文件名");
  chooseFiles(mounted.root, [new File(["bad"], "broken.ttf")]); await settle(); expect(mounted.root.textContent).toContain("无效的 TTF/OTF");
  chooseFiles(mounted.root, [font("Book-Regular.ttf")]); await settle(); fire(button(mounted.root, "确认安装"), "click"); await settle();
  expect(mounted.root.textContent).toContain("字体文件已存在"); expect(await fs.bytes("fonts/Book-Regular.ttf")).toHaveLength(12);
  chooseFiles(mounted.root, [font("New.ttf")]); await settle(); fs.unplug(); await manager.probe(); await settle();
  expect(button(mounted.root, "确认安装")).toBeUndefined();
  fs.plug(); await expect(fs.bytes("fonts/New.ttf")).rejects.toMatchObject({ name: "NotFoundError" });
});

it("deletes the selected family only after confirmation and leaves ignored files intact", async () => {
  const { fs, manager } = await paired(["Book-Regular.ttf", "Book-Bold.ttf", "Other-Regular.otf"]);
  await fs.write("fonts/._Book.ttf", "resource"); await fs.write("fonts/Readme.txt", "readme");
  const mounted = mount("fonts", manager); await settle();
  const row = byAttribute(mounted.root, "data-font-family", "Book");
  fire(button(row, "从设备删除 Book"), "click"); ui.flush(); expect(await fs.bytes("fonts/Book-Regular.ttf")).toHaveLength(12);
  fire(button(mounted.root, "删除整个家族"), "click"); await settle();
  await expect(fs.bytes("fonts/Book-Regular.ttf")).rejects.toMatchObject({ name: "NotFoundError" });
  expect(await fs.bytes("fonts/Other-Regular.otf")).toHaveLength(12); expect(await fs.text("fonts/._Book.ttf")).toBe("resource"); expect(await fs.text("fonts/Readme.txt")).toBe("readme");
  expect(allByAttribute(mounted.root, "data-font-family").map(row => row.getAttribute("data-font-family"))).toEqual(["Other"]);
});
