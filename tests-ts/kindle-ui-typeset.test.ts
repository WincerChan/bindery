import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { solidOptions } from "../scripts/solid-options";
import { KindleDeviceManager } from "../src/client/kindle/device";
import { defaultProfile, EMPTY_SETTINGS, type TypesettingProfile } from "../src/client/kindle/profiles";
import type { HandleRepository, RememberedDevice } from "../src/client/kindle/remembered";
import type { ProfileApi } from "../src/features/kindle/typeset/preview-page";
import type { PreviewData } from "../src/features/kindle/typeset/model";
import type { KindleContextValue } from "../src/features/kindle/context";
import { clientDocument, elements, fire } from "./support/client-dom";
import { FakeDirectory, fakeKindle } from "./support/fake-fs";
import { previewDocumentFixture } from "./support/kindle-preview-dom";

type Props = { manager: KindleDeviceManager | null; data: PreviewData; profiles: ProfileApi; chapters: (book: string) => Promise<{ title: string; item_path: string }[]>; initialFont?: string; onDirty?: (dirty: boolean) => void; onPreview?: (font: string) => unknown };
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
const custom = (deviceId: string): TypesettingProfile => ({ id: "custom", deviceId, name: "正文", builtIn: false, settings: { ...EMPTY_SETTINGS, marginX: 1, lineHeight: 1.6 } });
function api(): ProfileApi {
  return {
    list: vi.fn(async id => [defaultProfile(id), custom(id)]),
    create: vi.fn(async input => ({ ...input, id: "new-profile", builtIn: false })),
    update: vi.fn(async input => ({ ...input, builtIn: false })), delete: vi.fn(async () => ({ ok: true })),
  };
}
function globals() {
  const page = clientDocument(), prototype = Object.getPrototypeOf(page.createElement("div"));
  page.addEventListener = vi.fn(); page.removeEventListener = vi.fn();
  const body = page.createElement("body"); body.dispatchEvent = vi.fn(() => true); Object.defineProperty(page, "body", { value: body, configurable: true });
  vi.stubGlobal("showDirectoryPicker", vi.fn());
  vi.stubGlobal("scrollTo", vi.fn());
  // Only browser property reflection / style mutation needed by this slice; no layout emulation.
  for (const key of ["width", "height"]) Object.defineProperty(prototype, key, { configurable: true,
    get(this: Element) { return Number(this.getAttribute(key)); }, set(this: Element, value: number) { this.setAttribute(key, String(value)); },
  });
  Object.defineProperty(prototype, "disabled", { configurable: true,
    get(this: Element) { return this.hasAttribute("disabled"); }, set(this: Element, value: boolean) { if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); },
  });
  const styles = new WeakMap<Element, object>();
  Object.defineProperty(prototype, "style", { configurable: true, get(this: Element) {
    if (!styles.has(this)) styles.set(this, { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" });
    return styles.get(this);
  } });
  vi.stubGlobal("document", page); vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { confirm: vi.fn(() => true), location: new URL("http://bindery.local/kindle/preview") }));
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
    import { TypesetPage } from ${JSON.stringify(resolve("src/features/kindle/typeset/preview-page.tsx"))};
    import { FontsPage } from ${JSON.stringify(resolve("src/features/kindle/typeset/fonts-page.tsx"))};
    import { KindleProvider, useKindle } from ${JSON.stringify(resolve("src/features/kindle/context.tsx"))};
    import { KindleDeviceBar } from ${JSON.stringify(resolve("src/features/kindle/device-bar.tsx"))};
    import { KindleTabs } from ${JSON.stringify(resolve("src/features/kindle/tabs.tsx"))};
    import { KindleDeviceManager } from ${JSON.stringify(resolve("src/client/kindle/device.ts"))};
    import { Route as PreviewRoute } from ${JSON.stringify(resolve("src/routes/_app.kindle.preview.tsx"))};
    import { Route as FontsRoute } from ${JSON.stringify(resolve("src/routes/_app.kindle.fonts.tsx"))};
    export const manager = repo => new KindleDeviceManager(repo);
    function view(kind, props) { return kind === "fonts" ? <FontsPage manager={props.manager} onPreview={props.onPreview} /> : <TypesetPage {...props} />; }
    export function markup(kind, props) { return renderToString(() => <Loading>{view(kind, props)}</Loading>); }
    export function mount(root, kind, props) { return { dispose: hydrate(() => <Loading>{view(kind, props)}</Loading>, root), flush }; }
    function routes(kind, props) {
      let context;
      function Capture() { context = useKindle(); return null; }
      const root = createRootRoute();
      const layout = createRoute({ getParentRoute: () => root, path: '/kindle', component: () => <KindleProvider manager={props.manager} queue={{ snapshot: () => [], subscribe: () => () => {} }}><Capture /><div class="kindle-page"><KindleDeviceBar /><KindleTabs /><Outlet /></div></KindleProvider> });
      const page = (kind === 'fonts' ? FontsRoute : PreviewRoute).update({ getParentRoute: () => layout, path: kind, loader: async () => props.data });
      return { router: createRouter({ routeTree: root.addChildren([layout.addChildren([page])]), history: createMemoryHistory({ initialEntries: ['/kindle/' + kind] }), isServer, origin: 'http://bindery.local' }), context: () => context };
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
        if (id.includes("server/kindle/functions")) return "\0kindle-ui-profiles";
        if (id.endsWith("/server/functions")) return "\0kindle-ui-auth";
        if (id.endsWith("/typeset/preview.server")) return "\0kindle-ui-preview";
        if (id === "@tanstack/solid-start") return "\0kindle-ui-start";
      }, load(id) {
        if (id === "\0kindle-ui-profiles") return `
          export const listKindleProfiles = ({ data }) => globalThis.__kindleProfiles.list(data);
          export const createKindleProfile = ({ data }) => globalThis.__kindleProfiles.create(data);
          export const updateKindleProfile = ({ data }) => globalThis.__kindleProfiles.update(data);
          export const deleteKindleProfile = ({ data }) => globalThis.__kindleProfiles.delete(data.deviceId, data.id);
        `;
        if (id === "\0kindle-ui-auth") return "export const authenticated = {}";
        if (id === "\0kindle-ui-preview") return "export const previewData = () => { throw Error('unexpected preview RPC') }; export const previewChapters = previewData;";
        if (id === "\0kindle-ui-start") return "export function createServerFn() { const chain = { middleware: () => chain, inputValidator: () => chain, handler: () => () => { throw Error('unexpected server RPC') } }; return chain; }";
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
  const props: Props = { manager, data, profiles: api(), chapters: async () => [{ title: "第二章", item_path: "Text/b.xhtml" }], ...extra };
  const root = document.createElement("div"); root.innerHTML = ssr.markup(kind, props); document.documentElement.appendChild(root);
  expect(root.textContent).toContain("检测中…");
  prepare?.(root);
  vi.stubGlobal("_$HY", { r: {}, completed: new WeakSet(), events: [] });
  const mounted = ui.mount(root as HTMLElement, kind, props); disposers.push(() => root.remove(), mounted.dispose);
  return { root, props, ...mounted };
}
const button = (root: Element, text: string) => elements(root, "button").find(element => element.textContent === text || element.getAttribute("aria-label") === text)!;
function setValue(node: Element, value: string, type = "input") { (node as HTMLInputElement).value = value; fire(node, type); ui.flush(); }
const input = (root: Element, id: string) => elements(root, "input").find(element => element.id === id)!;
const labels = (root: Element, tag: string, label: string) => elements(root, "label").find(element => element.firstChild?.textContent === label)!.getElementsByTagName(tag)[0]!;
const withClass = (root: Element, name: string) => elements(root, "*").find(node => node.className.split(/\s+/).includes(name))!;

it("renders the two preview sections, profile selector, model states and generated CSS in neutral SSR", () => {
  const root = document.createElement("div"); root.innerHTML = ssr.markup("preview", { manager: null, data, profiles: api(), chapters: async () => [] });
  const layout = withClass(root, "kt-preview-layout"), editor = withClass(layout, "kt-editor"), preview = withClass(layout, "kt-preview");
  expect(Array.from(layout.childNodes).filter(node => node.nodeType === 1)).toEqual([editor, preview]);
  expect(elements(root, "h2").filter(node => node.textContent === "排版方案")).toHaveLength(1);
  expect(elements(root, "h2").some(node => node.textContent === "排版与预览")).toBe(false);
  expect(labels(editor, "select", "方案所属设备")).toBeDefined();
  expect(labels(editor, "select", "方案").hasAttribute("disabled")).toBe(true);
  const models = withClass(editor, "kt-models");
  expect(models.getAttribute("role")).toBe("group"); expect(models.getAttribute("aria-label")).toBe("预览型号");
  expect(elements(models, "button").map(node => [node.textContent, node.getAttribute("aria-pressed")]))
    .toEqual([["KO3", "false"], ["KPW3", "true"], ["其他", "false"]]);
  expect(elements(editor, "input").filter(node => node.getAttribute("type") === "range").map(node => node.id))
    .toEqual(["kt-marginX", "kt-lineHeight", "kt-paragraphSpacing", "kt-textIndent"]);
  expect(labels(editor, "textarea", "生成的 CSS（只读）").hasAttribute("readonly")).toBe(true);
  expect(withClass(editor, "kt-profile-actions").textContent).toBe("重置删除另存为保存方案");
  const toolbar = withClass(preview, "kt-preview-toolbar");
  expect(labels(toolbar, "select", "预览书籍")).toBeDefined(); expect(labels(toolbar, "select", "章节")).toBeDefined();
  expect(withClass(toolbar, "kt-spec").textContent).toContain("1072×1448");
  expect(elements(preview, "iframe")[0]!.getAttribute("sandbox")).toBe("allow-same-origin");
});

it("renders the fonts title, summary, actions, five scoped columns and installation help in SSR", () => {
  const root = document.createElement("div"); root.innerHTML = ssr.markup("fonts", { manager: null, data, profiles: api(), chapters: async () => [] });
  const heading = withClass(root, "kt-heading");
  expect(elements(heading, "h2").map(node => node.textContent)).toEqual(["字体"]);
  expect(heading.textContent).toContain("0 个家族 · 0 个字体文件");
  expect(elements(heading, "button").map(node => node.textContent)).toEqual(["重新扫描", "添加字体"]);
  expect(button(heading, "重新扫描").className).toContain("btn-secondary");
  expect(button(heading, "添加字体").className).toContain("btn-primary");
  const table = withClass(root, "kt-font-table");
  expect(elements(table, "th").map(node => node.textContent)).toEqual(["家族", "样张", "字重 / 样式", "大小", "操作"]);
  for (const cell of elements(table, "th")) expect(cell.getAttribute("scope")).toBe("col");
  expect(table.parentElement!.getAttribute("aria-label")).toBe("字体列表");
  const help = withClass(root, "kt-font-help"); expect(help.getAttribute("aria-label")).toBe("添加字体");
  expect(elements(help, "h2")[0]!.textContent).toBe("添加字体"); expect(elements(help, "svg")[0]!.getAttribute("aria-hidden")).toBe("true");
});

async function mountRouted(kind: string, manager: KindleDeviceManager, extra: Partial<Props> = {}) {
  const props: Props = { manager, data, profiles: api(), chapters: async () => [], ...extra };
  vi.stubGlobal("__kindleProfiles", props.profiles);
  const root = document.createElement("div"); root.innerHTML = await ssr.routedMarkup(kind, props); document.documentElement.appendChild(root);
  const bar = elements(root, "section", "data-kindle-device-bar")[0]!;
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

it.each([false, true])("hydrates the actual preview route, preserves SSR nodes and updates the visible bar (already connected=%s)", async alreadyConnected => {
  const { fs, repo } = await paired(), manager = ui.manager(repo);
  if (alreadyConnected) await manager.restore((await repo.list())[0]!);
  const mounted = await mountRouted("preview", manager), frame = elements(mounted.root, "iframe")[0]!;
  await settle();
  expect(mounted.root.textContent).not.toContain("Something went wrong");
  expect(elements(mounted.root, "section", "data-kindle-device-bar")).toEqual([mounted.bar]);
  expect(mounted.bar.textContent).toContain("已连接");
  expect(mounted.bar.textContent).toContain("我的 Paperwhite");
  expect(mounted.props.profiles.list).toHaveBeenCalledOnce();
  expect((labels(mounted.root, "select", "方案所属设备") as HTMLSelectElement).value).toBe(manager.snapshot().device!.identity.id);
  fs.operations = []; await manager.probe(); await settle();
  expect(mounted.props.profiles.list).toHaveBeenCalledOnce();
  expect(fs.operations.filter(op => op.operation === "values" && op.path === "/fonts")).toEqual([]);
  setValue(labels(mounted.root, "select", "方案"), "custom", "change"); setValue(input(mounted.root, "kt-marginX"), "2");
  expect(mounted.root.textContent).toContain("有未保存的修改");
  fs.unplug(); await manager.probe(); await settle(); expect(mounted.bar.textContent).toContain("已断开");
  fs.plug(); await manager.probe(); await settle(); expect(mounted.bar.textContent).toContain("已连接");
  expect(elements(mounted.root, "iframe")[0]).toBe(frame);
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("2");
});

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
    expect(elements(mounted.root, "tr", "data-font-family").map(row => row.getAttribute("data-font-family"))).toEqual(["Routed"]);
    expect(mounted.root.textContent).toContain("已安装 1 个字体文件");
    expect(mounted.root.textContent).not.toContain("正在读取或更新设备字体");
    expect(mounted.bar.textContent).toContain("字体 12 B");
  });
  expect(await fs.bytes("fonts/Routed-Regular.otf")).toEqual(new Uint8Array(await font("Routed-Regular.otf").arrayBuffer()));
  fire(button(mounted.root, "从设备删除 Routed"), "click"); ui.flush(); fire(button(mounted.root, "删除整个家族"), "click");
  await waitUi(() => { expect(mounted.bar.textContent).toContain("字体 0 B"); expect(elements(mounted.root, "tr", "data-font-family")).toHaveLength(0); });
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
  expect(elements(mounted.root, "tr", "data-font-family")).toHaveLength(1);
  expect(mounted.root.textContent).toContain("Light"); expect(mounted.root.textContent).toContain("手动安装");
  const sample = elements(mounted.root, "iframe")[0]!; expect(sample.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(elements(mounted.root, "a").find(a => a.getAttribute("aria-label") === "用 Book 预览")!.getAttribute("href")).toBe("/kindle/preview?font=Book");
  const actions = withClass(elements(mounted.root, "tr", "data-font-family")[0]!, "kt-row-actions");
  expect(elements(actions, "svg")).toHaveLength(2);
  expect(button(actions, "从设备删除 Book").className).toContain("btn-icon");
  fs.unplug(); await manager.probe(); await settle(); expect(elements(mounted.root, "tr", "data-font-family")).toHaveLength(0);
  expect(mounted.root.textContent).toContain("请连接并授权");
  fs.plug(); await manager.probe(); await settle(); expect(elements(mounted.root, "tr", "data-font-family")).toHaveLength(1);
});

it("navigates the preview action within the SPA while retaining a real font-specific link", async () => {
  const { manager } = await paired(["Book-Regular.ttf"]), onPreview = vi.fn();
  const mounted = mount("fonts", manager, { onPreview }); await settle();
  const link = elements(mounted.root, "a").find(anchor => anchor.getAttribute("aria-label") === "用 Book 预览")!;
  expect(link.getAttribute("href")).toBe("/kindle/preview?font=Book"); fire(link, "click");
  expect(onPreview).toHaveBeenCalledWith("Book");
});

it("hydrates preview with real chapter URLs and updates device fonts, profile CSS and offline state", async () => {
  const { fs, manager } = await paired(["Book-Regular.ttf"]), profiles = api();
  const mounted = mount("preview", manager, { profiles }); await settle();
  expect(profiles.list).toHaveBeenCalledWith(manager.snapshot().device!.identity.id);
  expect(mounted.root.textContent).toContain("正文");
  expect(elements(mounted.root, "option").map(option => option.textContent)).toContain("Book");
  const frame = elements(mounted.root, "iframe")[0]!;
  expect(frame.getAttribute("src")).toBe("/book/a/epub/Text/%E7%AC%AC%E4%B8%80%20%E7%AB%A0.xhtml");
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin"); expect(frame.getAttribute("width")).toBe("1072");
  setValue(labels(mounted.root, "select", "方案"), "custom", "change"); setValue(input(mounted.root, "kt-marginX"), "2.5");
  expect((labels(mounted.root, "textarea", "生成的 CSS（只读）") as HTMLTextAreaElement).value).toContain("margin-left: 2.5% !important");
  fs.unplug(); await manager.probe(); await settle();
  expect(mounted.root.textContent).toContain("可选择记住的设备离线编辑");
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("2.5");
});

it("applies and resets the negative-margin preset, previews calibrated counts, and persists the Kindle margin with its profile", async () => {
  const { manager, id } = await paired(), profiles = api();
  let stored = custom(id);
  vi.mocked(profiles.list).mockImplementation(async deviceId => [defaultProfile(deviceId), stored]);
  vi.mocked(profiles.update).mockImplementation(async value => { stored = { ...value, builtIn: false }; return stored; });
  const mounted = mount("preview", manager, { profiles }); await settle();
  const estimate = () => elements(mounted.root, "p", "data-kindle-line-estimate")[0]!.textContent;
  expect(estimate()).toBe("预计每行约 16 字（按 KPW3 · 字号 7 · 窄 实测校准）");
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  const margin = input(mounted.root, "kt-marginX");
  expect(margin.getAttribute("aria-label")).toBe("左右边距调整（%）");
  expect(margin.getAttribute("min")).toBe("-8.7"); expect(margin.getAttribute("step")).toBe("0.1");
  fire(button(mounted.root, "恢复 Kindle 默认"), "click"); ui.flush();
  expect(estimate()).toContain("约 16 字");
  fire(button(mounted.root, "收窄到约 1 字边距（-4.8%）"), "click"); ui.flush();
  expect((margin as HTMLInputElement).value).toBe("-4.8"); expect(estimate()).toContain("约 18 字");
  expect(mounted.root.textContent).toContain("-4.8 %（字号 7 约 -0.80 em）");
  expect((labels(mounted.root, "textarea", "生成的 CSS（只读）") as HTMLTextAreaElement).value).toContain("margin-left: -4.8% !important");
  fire(button(mounted.root, "恢复 Kindle 默认"), "click"); ui.flush();
  setValue(labels(mounted.root, "select", "Kindle 页边距设置"), "medium", "change"); expect(estimate()).toContain("约 14 字");
  setValue(labels(mounted.root, "select", "Kindle 页边距设置"), "wide", "change"); expect(estimate()).toContain("约 11 字");
  expect(margin.getAttribute("min")).toBe("-34.8");
  expect(mounted.root.textContent).toContain("上下页边距按 KPW3 窄边距实测，其他档位与型号为估算");
  fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(stored.settings).toMatchObject({ deviceModel: "KPW3", kindleMargin: "wide", marginX: null });
  mounted.dispose();
  const reloaded = mount("preview", manager, { profiles }); await settle();
  setValue(labels(reloaded.root, "select", "方案"), "custom", "change");
  expect((labels(reloaded.root, "select", "Kindle 页边距设置") as HTMLSelectElement).value).toBe("wide");
  expect(reloaded.root.textContent).toContain("预计每行约 11 字");
});

it("keeps a legacy em margin until edited, then switches the adjustment to percent", async () => {
  const { manager, id } = await paired(), profiles = api();
  let stored: TypesettingProfile = { ...custom(id), settings: { ...custom(id).settings, marginX: 1, marginXUnit: "em" } };
  vi.mocked(profiles.list).mockImplementation(async deviceId => [defaultProfile(deviceId), stored]);
  vi.mocked(profiles.update).mockImplementation(async value => { stored = { ...value, builtIn: false }; return stored; });
  const mounted = mount("preview", manager, { profiles }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  const css = () => (labels(mounted.root, "textarea", "生成的 CSS（只读）") as HTMLTextAreaElement).value;
  expect(mounted.root.textContent).toContain("1 em（旧方案单位");
  expect(css()).toContain("margin-left: 1em !important");
  // 55px of the 912px narrow column at size 7.
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("6");
  expect(mounted.root.textContent).not.toContain("有未保存的修改");
  setValue(input(mounted.root, "kt-marginX"), "-4.8");
  expect(css()).toContain("margin-left: -4.8% !important");
  fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(stored.settings).toMatchObject({ marginX: -4.8, marginXUnit: "percent" });
});

it("uses the selected margin's safety bound and labels unmeasured models as estimates", async () => {
  const { manager } = await paired(), mounted = mount("preview", manager); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  setValue(labels(mounted.root, "select", "Kindle 页边距设置"), "medium", "change");
  setValue(input(mounted.root, "kt-marginX"), "-15");
  expect((button(mounted.root, "保存方案") as HTMLButtonElement).disabled).toBe(false);
  setValue(labels(mounted.root, "select", "Kindle 页边距设置"), "narrow", "change");
  expect(mounted.root.textContent).toContain("避免超出设备屏幕");
  expect((button(mounted.root, "保存方案") as HTMLButtonElement).disabled).toBe(true);
  expect(mounted.root.textContent).toContain("排版参数无效，预览保留上次有效样式");
  const preview = mount("preview", null); await settle();
  fire(button(preview.root, "KO3"), "click"); ui.flush();
  expect(preview.root.textContent).toContain("KO3 按 KPW3 比例估算");
  fire(button(preview.root, "其他"), "click"); ui.flush();
  expect(preview.root.textContent).toContain("其他型号按 KPW3 比例估算");
});

it("updates preview asset modes live and includes both toggles in dirty, reset, save and save-as", async () => {
  const { manager, id } = await paired(), profiles = api(), onDirty = vi.fn();
  const mounted = mount("preview", manager, { profiles, onDirty }); await settle();
  const toggle = (label: string) => elements(mounted.root, "label").find(node => node.textContent === label)!.getElementsByTagName("input")[0] as HTMLInputElement;
  const change = (label: string, checked: boolean) => { const node = toggle(label); node.checked = checked; fire(node, "change"); ui.flush(); };
  expect(toggle("去掉书籍自带字体").disabled).toBe(true);
  expect(toggle("去掉所有图片").disabled).toBe(true);
  expect(mounted.root.textContent).toContain("Kindle 上使用你选的字体；书里嵌入的字体文件会被移除");
  expect(mounted.root.textContent).toContain("保留封面；正文插图会被移除，文件更小");
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  const frame = elements(mounted.root, "iframe")[0]!;
  change("去掉书籍自带字体", true); expect(frame.getAttribute("src")).toContain(`/kindle/content/a/10/epub/`); expect(onDirty).toHaveBeenLastCalledWith(true);
  change("去掉所有图片", true); expect(frame.getAttribute("src")).toContain(`/kindle/content/a/11/epub/`);
  fire(button(mounted.root, "重置"), "click"); ui.flush(); expect(onDirty).toHaveBeenLastCalledWith(false); expect(frame.getAttribute("src")).toContain("/book/a/epub/");
  change("去掉所有图片", true); expect(frame.getAttribute("src")).toContain(`/kindle/content/a/01/epub/`);
  change("去掉书籍自带字体", true);
  fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(profiles.update).toHaveBeenCalledWith(expect.objectContaining({ id: "custom", deviceId: id, settings: expect.objectContaining({ stripFonts: true, stripImages: true }) }));
  expect(onDirty).toHaveBeenLastCalledWith(false);
  fire(button(mounted.root, "另存为"), "click"); ui.flush(); setValue(labels(mounted.root, "input", "新方案名称"), "精简正文");
  fire(elements(mounted.root, "form")[0]!, "submit"); await settle();
  expect(profiles.create).toHaveBeenCalledWith(expect.objectContaining({ name: "精简正文", settings: expect.objectContaining({ stripFonts: true, stripImages: true }) }));
  expect(toggle("去掉书籍自带字体").checked).toBe(true); expect(toggle("去掉所有图片").checked).toBe(true);
});

it("takes over a chapter already loaded before hydration and applies CSS and device fonts only inside its frame", async () => {
  const { manager, fs } = await paired(["Book-Regular.ttf"]), { document: doc, head, fonts } = previewDocumentFixture(), appFonts = new Set<FontFace>();
  Object.defineProperty(document, "fonts", { value: appFonts });
  const bookStyle = doc.createElement("style"); bookStyle.textContent = "p { color: black; }"; head.appendChild(bookStyle);
  vi.stubGlobal("FontFace", class { load() { return Promise.resolve(this); } });
  const mounted = mount("preview", manager, {}, root => { Object.defineProperty(elements(root, "iframe")[0]!, "contentDocument", { value: doc }); }); await settle();
  expect(elements(head, "style", "data-bindery-profile")).toHaveLength(1);
  expect(Array.from(head.childNodes).map(node => node.textContent)).toEqual([
    expect.stringContaining("font-size: 55px"), bookStyle.textContent, "",
  ]);
  setValue(labels(mounted.root, "select", "Kindle 页边距设置"), "medium", "change");
  expect(head.firstChild!.textContent).toContain("margin: 52px 137px 70px !important");
  setValue(labels(mounted.root, "select", "方案"), "custom", "change");
  setValue(labels(mounted.root, "select", "字体（设备上已安装）"), "Book", "change"); await settle();
  expect(elements(head, "style", "data-bindery-profile")[0]!.textContent).toContain('font-family: "Book"');
  expect(bookStyle.textContent).toBe("p { color: black; }"); expect(fonts.size).toBe(1); expect(appFonts.size).toBe(0);
  // Invalid CSS retains the last stylesheet; loss of device access still removes its FontFaces.
  setValue(labels(mounted.root, "textarea", "额外自定义 CSS"), "p {"); fs.unplug(); await manager.probe(); await settle(); expect(fonts.size).toBe(0);
  mounted.dispose(); expect(elements(head, "style", "data-bindery-profile")).toHaveLength(0); expect(bookStyle.parentNode).toBe(head);
});

it("hydrates neutral page controls in place and turns pages, chapter boundaries and selector resets", async () => {
  const bookData = { ...data, sections: [...data.sections, { title: "第二章", item_path: "Text/b.xhtml" }] };
  let current = previewDocumentFixture();
  let originalControls!: Element, originalScreen!: Element, originalButtons!: Element[];
  const mounted = mount("preview", null, { data: bookData }, root => {
    originalControls = withClass(root, "kt-page-controls"); originalScreen = withClass(root, "kt-screen");
    originalButtons = elements(originalControls, "button");
    expect(originalControls.textContent).toBe("上一页正在分页…下一页");
    expect(originalButtons.every(button => button.hasAttribute("disabled"))).toBe(true);
    expect(elements(originalControls, "span")[0]!.getAttribute("aria-live")).toBe("polite");
    expect(originalScreen.getAttribute("tabindex")).toBe("0");
    Object.defineProperty(elements(root, "iframe")[0]!, "contentDocument", { configurable: true, get: () => current.document });
  });
  await settle();
  const { root } = mounted, status = () => elements(root, "span", "data-kindle-page-status")[0]!.textContent;
  const previous = () => button(root, "上一页") as HTMLButtonElement, next = () => button(root, "下一页") as HTMLButtonElement;
  const iframe = elements(root, "iframe")[0]!;
  expect(withClass(root, "kt-page-controls")).toBe(originalControls); expect(withClass(root, "kt-screen")).toBe(originalScreen);
  expect(elements(originalControls, "button")).toEqual(originalButtons);
  expect(status()).toBe("第 1 / 3 页"); expect(previous().disabled).toBe(true); expect(next().disabled).toBe(false);
  fire(next(), "click"); ui.flush(); expect(status()).toBe("第 2 / 3 页");
  fire(originalScreen, "keydown", { key: "PageDown" }); ui.flush(); expect(status()).toBe("第 3 / 3 页");
  fire(next(), "click"); ui.flush();
  expect(iframe.getAttribute("src")).toBe("/book/a/epub/Text/b.xhtml"); expect(next().disabled).toBe(true);
  current = previewDocumentFixture("/book/a/epub/Text/b.xhtml"); current.setExtent(2 * 1072 - 80);
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

it("keeps the built-in profile immutable, saves a copy, then updates and deletes only that device's custom profile", async () => {
  const { manager, id } = await paired(), profiles = api(), mounted = mount("preview", manager, { profiles }); await settle();
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).disabled).toBe(true);
  expect((button(mounted.root, "删除") as HTMLButtonElement).disabled).toBe(true);
  fire(button(mounted.root, "另存为"), "click"); ui.flush();
  setValue(labels(mounted.root, "input", "新方案名称"), "大字正文");
  fire(elements(mounted.root, "form")[0]!, "submit"); await settle();
  expect(profiles.create).toHaveBeenCalledWith({ deviceId: id, name: "大字正文", settings: EMPTY_SETTINGS });
  setValue(input(mounted.root, "kt-textIndent"), "2"); fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(profiles.update).toHaveBeenCalledWith(expect.objectContaining({ id: "new-profile", deviceId: id, settings: expect.objectContaining({ textIndent: 2 }) }));
  fire(button(mounted.root, "删除"), "click"); ui.flush();
  expect(profiles.delete).not.toHaveBeenCalled();
  const dialogs = elements(mounted.root, "dialog"), confirm = dialogs[1]!;
  fire(button(confirm, "确认"), "click"); await settle();
  expect(profiles.delete).toHaveBeenCalledWith(id, "new-profile");
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).disabled).toBe(true);
});

it("guards profile switching and reset, validates CSS, and reports failed saves without losing the draft", async () => {
  const { manager } = await paired(), profiles = api(), onDirty = vi.fn(), mounted = mount("preview", manager, { profiles, onDirty }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change"); setValue(input(mounted.root, "kt-marginX"), "3");
  vi.mocked(window.confirm).mockReturnValue(false); setValue(labels(mounted.root, "select", "方案"), "default", "change");
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("3");
  expect((labels(mounted.root, "select", "方案") as HTMLSelectElement).value).toBe("custom");
  fire(button(mounted.root, "重置"), "click"); ui.flush(); expect(mounted.root.textContent).toContain("有未保存的修改");
  vi.mocked(window.confirm).mockReturnValue(true); fire(button(mounted.root, "重置"), "click"); ui.flush();
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("1");
  setValue(labels(mounted.root, "textarea", "额外自定义 CSS"), "p {");
  expect(mounted.root.textContent).toContain("CSS 花括号不匹配"); expect((button(mounted.root, "保存方案") as HTMLButtonElement).disabled).toBe(true);
  setValue(labels(mounted.root, "textarea", "额外自定义 CSS"), "p { color: black; }");
  vi.mocked(profiles.update).mockRejectedValueOnce(new Error("数据库暂不可用")); fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(mounted.root.textContent).toContain("数据库暂不可用"); expect(mounted.root.textContent).toContain("有未保存的修改"); expect(onDirty).toHaveBeenLastCalledWith(true);
});

it("holds a dirty draft on its original device during an external device change", async () => {
  const first = await paired(), second = await paired(), profiles = api();
  const mounted = mount("preview", first.manager, { profiles }); await settle();
  setValue(labels(mounted.root, "select", "方案"), "custom", "change"); setValue(input(mounted.root, "kt-marginX"), "4");
  await first.repo.put((await second.manager.remembered())[0]!); await first.manager.restore(second.id); await settle();
  expect(mounted.root.textContent).toContain("保存仍属于");
  fire(button(mounted.root, "保存方案"), "click"); await settle();
  expect(profiles.update).toHaveBeenCalledWith(expect.objectContaining({ deviceId: first.id }));
});

it("supports a remembered Oasis without FSA permission and applies a font link to an unsaved preview copy", async () => {
  const { manager, fs } = await paired();
  const saved = (await manager.remembered())[0]!; saved.identity.model = "KO3";
  fs.permission = "prompt"; await manager.restore(saved); const profiles = api();
  const mounted = mount("preview", manager, { profiles, initialFont: "Book" }); await settle();
  expect(elements(mounted.root, "iframe")[0]!.getAttribute("width")).toBe("1264");
  expect(mounted.root.textContent).toContain("字体预览"); expect(mounted.root.textContent).toContain("有未保存的修改");
  expect(mounted.root.textContent).toContain("预览暂用替代字体");
  expect(profiles.update).not.toHaveBeenCalled(); expect(profiles.create).not.toHaveBeenCalled();
});

it("chooses a remembered device's model and profiles without selecting or opening its handle", async () => {
  const { repo, fs, id } = await paired(); repo.devices.get(id)!.identity.model = "KO3";
  const manager = new KindleDeviceManager(repo); fs.operations = [];
  const mounted = mount("preview", manager); await settle();
  setValue(labels(mounted.root, "select", "方案所属设备"), id, "change"); await settle();
  expect(elements(mounted.root, "iframe")[0]!.getAttribute("width")).toBe("1264");
  expect(mounted.props.profiles.list).toHaveBeenCalledWith(id); expect(manager.snapshot().device).toBeNull(); expect(fs.operations).toEqual([]);
});

it("rejects invalid font names from preview query data without breaking the page", async () => {
  const { manager } = await paired(), mounted = mount("preview", manager, { initialFont: "bad\nfont" }); await settle();
  expect(mounted.root.textContent).toContain("无效的字体名称");
  expect((button(mounted.root, "保存方案") as HTMLButtonElement).disabled).toBe(true);
  setValue(labels(mounted.root, "select", "字体（设备上已安装）"), "", "change");
  expect(mounted.root.textContent).not.toContain("无效的字体名称");
});

it("offers device-less model preview and protects against stale chapter responses", async () => {
  let finish!: (value: { title: string; item_path: string }[]) => void;
  const chapters = vi.fn((id: string) => id === "b" ? new Promise<{ title: string; item_path: string }[]>(resolve => { finish = resolve; }) : Promise.resolve([{ title: "新第一章", item_path: "new.xhtml" }]));
  const mounted = mount("preview", null, { chapters }); await settle();
  fire(button(mounted.root, "KO3"), "click"); ui.flush();
  expect(elements(mounted.root, "iframe")[0]!.getAttribute("width")).toBe("1264");
  const select = labels(mounted.root, "select", "预览书籍"); setValue(select, "b", "change"); setValue(select, "a", "change"); await settle();
  finish([{ title: "过期第二章", item_path: "stale.xhtml" }]); await settle();
  expect(elements(mounted.root, "iframe")[0]!.getAttribute("src")).toBe("/book/a/epub/new.xhtml");
  expect(elements(mounted.root, "option").map(option => option.textContent)).not.toContain("过期第二章");
});

function chooseFiles(root: Element, files: File[]) {
  const element = elements(root, "input").find(input => input.getAttribute("type") === "file") as HTMLInputElement;
  Object.defineProperty(element, "files", { value: files, configurable: true }); fire(element, "change"); ui.flush();
}
it("shows an inspected family batch before installation, writes only after confirmation, and rescans", async () => {
  const { fs, manager } = await paired(), mounted = mount("fonts", manager); await settle();
  chooseFiles(mounted.root, [font("Sample-Regular.ttf"), font("Sample-Medium.otf")]); await settle();
  expect(mounted.root.textContent).toContain("将安装到 我的 Paperwhite"); expect(mounted.root.textContent).toContain("Sample-Medium.otf");
  await expect(fs.bytes("fonts/Sample-Regular.ttf")).rejects.toMatchObject({ name: "NotFoundError" });
  fire(button(mounted.root, "确认安装"), "click"); await settle();
  expect(await fs.bytes("fonts/Sample-Regular.ttf")).toHaveLength(12); expect(elements(mounted.root, "tr", "data-font-family")).toHaveLength(1);
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
    const page = elements(mounted.root, "section").find(element => element.getAttribute("aria-label") === "字体管理")!;
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
  const row = elements(mounted.root, "tr", "data-font-family").find(row => row.getAttribute("data-font-family") === "Book")!;
  fire(button(row, "从设备删除 Book"), "click"); ui.flush(); expect(await fs.bytes("fonts/Book-Regular.ttf")).toHaveLength(12);
  fire(button(mounted.root, "删除整个家族"), "click"); await settle();
  await expect(fs.bytes("fonts/Book-Regular.ttf")).rejects.toMatchObject({ name: "NotFoundError" });
  expect(await fs.bytes("fonts/Other-Regular.otf")).toHaveLength(12); expect(await fs.text("fonts/._Book.ttf")).toBe("resource"); expect(await fs.text("fonts/Readme.txt")).toBe("readme");
  expect(elements(mounted.root, "tr", "data-font-family").map(row => row.getAttribute("data-font-family"))).toEqual(["Other"]);
});

it("unsubscribes page listeners and ignores a profile response arriving after disposal", async () => {
  const { manager } = await paired(); let finish!: (profiles: TypesettingProfile[]) => void;
  const profiles = api(); vi.mocked(profiles.list).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const subscribe = vi.spyOn(manager, "subscribe"), mounted = mount("preview", manager, { profiles }); await settle();
  expect(subscribe).toHaveBeenCalledTimes(1); mounted.dispose();
  finish([defaultProfile("x"), custom("x")]); await settle();
  expect(mounted.root.textContent).not.toContain("正文");
});
