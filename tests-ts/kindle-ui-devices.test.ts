import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { solidOptions } from "../scripts/solid-options";
import { KindleDeviceManager } from "../src/client/kindle/device";
import { pairDevice, type PairedDevice } from "../src/client/kindle/identity";
import { TransferQueue, type TransferItem } from "../src/client/kindle/queue";
import { defaultProfile, type TypesettingProfile } from "../src/client/kindle/profiles";
import type { ManifestBook } from "../src/client/kindle/manifest";
import type { RememberedDevice } from "../src/client/kindle/remembered";
import { KindleTransferService, type TransferOptions } from "../src/client/kindle/transfer";
import type { KindleContextValue } from "../src/features/kindle/context";
import type { KindleLibraryBook } from "../src/features/kindle/devices/library";
import { loadKindleLibrary } from "../src/features/kindle/devices/library";
import type { LibraryPageData } from "../src/server/library/queries";
import { fakeKindle, fakeKobo } from "./support/fake-fs";
import { detectDevice, pairDetectedDevice } from "../src/client/devices/identity";
import { MemoryDevicePreference } from "../src/client/devices/preferences";
import { clientDocument, elements, fire } from "./support/client-dom";

type Page = "books" | "connect" | "transfer";
interface Input { manager: KindleDeviceManager; queue: TransferQueue; books: KindleLibraryBook[]; loadProfiles: (id: string) => Promise<TypesettingProfile[]> }
interface Mounted { context(): KindleContextValue; page(page: Page): void; books(books: KindleLibraryBook[]): void; flush(): void; dispose(): void }
interface Probe {
  markup(page: Page, input: Input): string; mount(root: HTMLElement, page: Page, input: Input, hydrate: boolean): Mounted;
  progressMarkup(items: TransferItem[]): string;
  mountProgress(root: HTMLElement, items: TransferItem[], hydrate: boolean): { update(items: TransferItem[]): void; dispose(): void };
}
let client: Probe, server: Probe;
const directory = mkdtempSync(join(tmpdir(), "bindery-kindle-ui-devices-")), disposers: (() => void)[] = [];
const virtualId = join(directory, "probe.tsx");
// Keep fixtures inside this owned test file; compile real page components with the production RC options.
const probeSource = `
import { hydrate, render, renderToString } from '@solidjs/web';
import { createSignal, flush, Loading } from 'solid-js';
import { KindleProvider, useKindle } from '${resolve("src/features/kindle/context")}';
import { KindleDeviceBar } from '${resolve("src/features/kindle/device-bar")}';
import { KindleBooksPage } from '${resolve("src/features/kindle/devices/books")}';
import { KindleConnectPage } from '${resolve("src/features/kindle/devices/connect")}';
import { KindleTransferPage, KindleTransferQueueProgress } from '${resolve("src/features/kindle/devices/transfer")}';
function Capture(props) { props.receive(useKindle()); return null; }
function view(page, input, books, capture) {
  function child() {
    switch (page()) {
      case 'books': return <KindleBooksPage books={books()} />;
      case 'connect': return <KindleConnectPage />;
      case 'transfer': return <KindleTransferPage books={books()} loadProfiles={input.loadProfiles} />;
    }
  }
  return <Loading><KindleProvider manager={input.manager} queue={input.queue}><Capture receive={capture} /><KindleDeviceBar />{child()}</KindleProvider></Loading>;
}
export function markup(page, input) { return renderToString(() => view(() => page, input, () => input.books, () => {})); }
export function mount(root, initial, input, hydrating) {
  let context;
  const [page, setPage] = createSignal(initial), [books, setBooks] = createSignal(input.books);
  const dispose = (hydrating ? hydrate : render)(() => view(page, input, books, k => context = k), root);
  return { context: () => context, page(next) { setPage(next); flush(); }, books(next) { setBooks(next); flush(); }, flush, dispose };
}
const queueView = items => <KindleTransferQueueProgress items={items()} title={id => '书籍 ' + id} deviceName={() => 'KPW3'} cancel={() => {}} />;
export function progressMarkup(items) { return renderToString(() => queueView(() => items)); }
export function mountProgress(root, initial, hydrating) {
  const [items, setItems] = createSignal(initial);
  const dispose = (hydrating ? hydrate : render)(() => queueView(items), root);
  return { update(next) { setItems(next); flush(); }, dispose };
}`;

function globals(support = true) {
  const doc = clientDocument();
  // The shared Node-tree DOM deliberately omits CSSOM. This slice uses dynamic usage-bar widths.
  Object.defineProperty(Object.getPrototypeOf(doc.createElement("div")), "style", { configurable: true, get(this: Element) {
    return { setProperty: (name: string, value: string) => this.setAttribute("style", `${name}: ${value}`), removeProperty: () => this.removeAttribute("style") };
  } });
  const body = doc.createElement("body"); body.dispatchEvent = vi.fn(() => true); Object.defineProperty(doc, "body", { value: body, configurable: true });
  doc.addEventListener = vi.fn(); doc.removeEventListener = vi.fn();
  vi.stubGlobal("document", doc); vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("showDirectoryPicker", support ? vi.fn() : undefined);
}
beforeEach(() => globals());
beforeAll(async () => {
  globals();
  writeFileSync(virtualId, probeSource);
  for (const ssr of [false, true]) {
    const result = await build({ configFile: false, logLevel: "silent", plugins: [
      // These tests inject the profile API and queue service. Never bundle server-only RPC handlers into Node-tree DOM probes.
      { name: "kindle-ui-rpc-boundary", enforce: "pre", resolveId: (id, importer) => id.includes("server/kindle/functions") && importer ? "\0kindle-ui-rpc" : undefined, load: id => id === "\0kindle-ui-rpc" ? "export const listKindleProfiles = async () => { throw Error('unexpected RPC in UI test') }" : undefined },
      solid(solidOptions),
    ], resolve: { dedupe: ["solid-js", "@solidjs/web"], conditions: ssr ? ["node", "production"] : ["browser", "production"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") }, ssr: { noExternal: true },
    build: { write: false, minify: true, ...(ssr ? { ssr: virtualId } : { lib: { entry: virtualId, formats: ["es" as const] } }), rollupOptions: { output: { inlineDynamicImports: true } } },
    });
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing Kindle UI test bundle");
    expect(chunk.imports.filter(id => !ssr || !["node:module", "module"].includes(id))).toEqual([]);
    const filename = join(directory, ssr ? "server.mjs" : "client.mjs"); writeFileSync(filename, chunk.code);
    const loaded = await import(/* @vite-ignore */ pathToFileURL(filename).href) as Probe;
    if (ssr) server = loaded; else client = loaded;
  }
});
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => rmSync(directory, { force: true, recursive: true }));
const book = (id: string, title = id, read = false): KindleLibraryBook => ({ book_id: id, title, author: "作者", cover_url: null, read });
function repository(initial: RememberedDevice[] = []) {
  const rows = new Map(initial.map(d => [d.id, d]));
  return { list: async () => [...rows.values()], put: async (d: RememberedDevice) => { rows.set(d.id, d); }, remove: async (id: string) => { rows.delete(id); } };
}
const saved = (d: PairedDevice): RememberedDevice => ({ id: d.identity.id, identity: d.identity, root: d.root });
const record = (id: string, filename: string, profile = "default"): ManifestBook => ({ book_id: id, filename, content_id: `id_${id}`, cde_content_type: "EBOK", profile_id: profile, profile_name: profile === "default" ? "默认" : "宽边距", transferred_at: "2026-10-19T03:04:05Z", size: 4, thumbnail: null });
function input(manager = new KindleDeviceManager(repository()), books = [book("a", "书库甲"), book("b", "书库乙", true)]): Input {
  return { manager, books, queue: new TransferQueue({ transferBook: async () => { throw new Error("测试队列尚未接入转换服务"); } }), loadProfiles: async id => [defaultProfile(id)] };
}
async function twoDevices() {
  const kindle = await fakeKindle(), kobo = await fakeKobo("N418");
  const a = await pairDevice(kindle.root, "KPW3", "Kindle A");
  const b = await pairDetectedDevice(kobo.root, await detectDevice(kobo.root), "libra2", "Kobo B");
  return { kindle, kobo, a, b };
}
async function connectedKobo(files: string[] = []) {
  const fs = await fakeKobo("N418");
  for (const filename of files) await fs.write(filename, "BOOK");
  const detection = await detectDevice(fs.root), device = await pairDetectedDevice(fs.root, detection, detection.model, "我的 Libra 2");
  const repo = repository([saved(device)]), manager = new KindleDeviceManager(repo, async () => fs.root);
  return { fs, device, repo, manager, input: input(manager) };
}
async function connected(records: ManifestBook[] = []) {
  const fs = await fakeKindle();
  for (const r of records) await fs.write(`documents/${r.filename}`, "BOOK");
  if (records.length) await fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: records }));
  const device = await pairDevice(fs.root, "KPW3", "我的 Paperwhite"), repo = repository([saved(device)]);
  const manager = new KindleDeviceManager(repo, async () => fs.root);
  return { fs, device, repo, manager, input: input(manager) };
}
function mount(page: Page, initial: Input, hydrating = true) {
  const node = document.createElement("div");
  if (hydrating) { node.innerHTML = server.markup(page, initial); vi.stubGlobal("_$HY", { r: {}, completed: new WeakSet(), events: [] }); }
  document.documentElement.appendChild(node);
  const mounted = client.mount(node, page, initial, hydrating);
  disposers.push(() => { mounted.dispose(); node.remove(); });
  return { ...mounted, root: node };
}
async function settle(m: Mounted) { for (let i = 0; i < 6; i++) { await new Promise(resolve => setTimeout(resolve, 0)); m.flush(); } }
function button(root: Element, text: string) { const node = elements(root, "button").find(b => b.textContent === text || b.getAttribute("aria-label") === text); if (!node) throw new Error(`Missing button: ${text}`); return node; }
function field(root: Element, label: string) { const node = elements(root, "input").find(el => el.getAttribute("aria-label") === label || elements(root, "label").some(l => l.getAttribute("for") === el.id && l.textContent === label)); if (!node) throw new Error(`Missing input: ${label}`); return node as HTMLInputElement; }
const text = (m: { root: Element }) => m.root.textContent || "";
const withClass = (root: Element, name: string) => elements(root, "*").find(node => node.className.split(/\s+/).includes(name))!;

it("keeps the device identity hierarchy and the complete books toolbar/table in neutral SSR", async () => {
  const c = await connected([record("a", "a.kfx")]); await c.manager.restore(saved(c.device));
  const root = document.createElement("div"); root.innerHTML = server.markup("books", c.input);
  const bar = elements(root, "section", "data-kindle-device-bar")[0]!;
  expect(elements(bar, "h1").map(node => node.textContent)).toEqual(["设备"]);
  const identity = withClass(bar, "kindle-device-identity");
  expect(Array.from(identity.childNodes).filter(node => node.nodeType === 1).map(node => (node as Element).tagName)).toEqual(["h1", "p"]);
  expect(withClass(bar, "kindle-status").getAttribute("role")).toBe("status");
  expect(withClass(bar, "kindle-status").className).toContain("page-description");
  expect(bar.textContent).not.toContain("我的 Paperwhite");

  const toolbar = withClass(root, "kindle-books-toolbar");
  expect(Array.from(toolbar.childNodes).filter(node => node.nodeType === 1).map(node => (node as Element).className))
    .toEqual(["kindle-section-heading", "kindle-filters", "kindle-toolbar-actions"]);
  const heading = withClass(toolbar, "kindle-section-heading");
  expect(elements(heading, "h2").map(node => node.textContent)).toEqual(["书籍"]);
  expect(withClass(heading, "kindle-count").className).toContain("kindle-mono");
  expect(withClass(heading, "kindle-count").textContent).toBe("0 本 · 0 B");
  const filters = withClass(toolbar, "kindle-filters");
  expect(filters.getAttribute("role")).toBe("group"); expect(filters.getAttribute("aria-label")).toBe("按来源筛选");
  expect(elements(filters, "button").map(node => [node.textContent, node.getAttribute("aria-pressed")]))
    .toEqual([["全部", "true"], ["来自 Bindery 0", "false"], ["其他 0", "false"]]);
  for (const filter of elements(filters, "button")) expect(filter.className).toContain("text-filter");
  const actions = withClass(toolbar, "kindle-toolbar-actions");
  expect(Array.from(actions.childNodes).filter(node => node.nodeType === 1).map(node => (node as Element).tagName)).toEqual(["label", "button", "a"]);
  expect(withClass(actions, "sr-only").textContent).toBe("搜索设备上的书");
  expect(button(actions, "删除所选（0）").className.split(/\s+/)).toContain("btn-quiet-danger");
  expect(button(actions, "删除所选（0）").hasAttribute("disabled")).toBe(true);
  expect(elements(actions, "a")[0]!.className).toContain("btn-primary");
  const table = withClass(root, "kindle-book-table");
  expect(elements(table, "th").map(node => node.textContent)).toEqual(["", "书籍", "来源", "格式", "排版方案", "大小", "传入时间", "操作"]);
  for (const cell of elements(table, "th")) expect(cell.getAttribute("scope")).toBe("col");
  expect(elements(table, "tbody")).toHaveLength(1); expect(elements(table, "tr", "data-device-book")).toHaveLength(0);
  const nodes = elements(root, "*"); expect(nodes.indexOf(table)).toBeLessThan(nodes.indexOf(withClass(root, "empty-state")));
});

it("renders the transfer heading, text filters, compact search, setting fields and ordered queue in SSR", () => {
  const root = document.createElement("div"); root.innerHTML = server.markup("transfer", input());
  expect(elements(root, "h2").slice(0, 3).map(node => node.textContent)).toEqual(["从书库选择", "设置", "队列"]);
  const toolbar = withClass(root, "kindle-toolbar"), filters = withClass(toolbar, "kindle-filters");
  expect(filters.getAttribute("role")).toBe("group"); expect(filters.getAttribute("aria-label")).toBe("筛选");
  expect(elements(filters, "button").map(node => [node.textContent, node.getAttribute("aria-pressed")]))
    .toEqual([["不在设备", "true"], ["未读", "false"], ["全部", "false"]]);
  for (const filter of elements(filters, "button")) expect(filter.className).toContain("text-filter");
  expect(withClass(toolbar, "kindle-search").getElementsByTagName("span")[0]!.className).toBe("sr-only");
  expect(elements(withClass(root, "kindle-library-list"), "li", "data-transfer-book")).toHaveLength(2);
  const aside = elements(root, "aside")[0]!, labels = elements(aside, "label");
  expect(labels.find(node => node.firstChild?.textContent === "目标设备")!.getElementsByTagName("select")[0]!.hasAttribute("disabled")).toBe(true);
  expect(labels.some(node => node.firstChild?.textContent === "排版方案")).toBe(true);
  const queue = withClass(aside, "kindle-queue");
  expect(withClass(queue, "kindle-queue-list").tagName).toBe("ol");
  expect(button(queue, "开始传输（0）").className).toContain("btn-primary");
  expect(aside.textContent).not.toContain("压缩超大图片");
});

it.each([true, false])("renders real queue progress and preserves stage-only live regions (hydration: %s)", hydrating => {
  const mb = 1024 * 1024;
  const item = (id: string, patch: Partial<TransferItem>): TransferItem => ({ id, deviceId: "kpw3", bookId: id, profileId: "default", state: "转换", phase: "download", message: "正在下载 EPUB", startedAt: 1000, phaseStartedAt: 1000, downloadedBytes: 0, writtenBytes: 0, ...patch });
  const initial = [
    item("done", { state: "完成", phase: "finalize", message: "已传入 Kindle", writtenBytes: 30 * mb, writeTotal: 30 * mb }),
    item("write", { state: "写入", phase: "write", message: "正在写入 Kindle", loaded: 15 * mb, total: 90 * mb, writtenBytes: 15 * mb, writeTotal: 90 * mb, bytesPerSecond: 4.8 * mb, etaSeconds: 15.625 }),
    item("convert", { phase: "convert", message: "正在转换 KFX · 已用 1.2 秒 · 预计剩余约 2 秒（估计）", etaSeconds: 2 }),
    item("download", { loaded: 2 * mb, total: 5 * mb, bytesPerSecond: mb, etaSeconds: 3 }),
    item("unknown", { loaded: mb }),
  ];
  const root = document.createElement("div"); document.documentElement.appendChild(root);
  if (hydrating) { root.innerHTML = server.progressMarkup(initial); vi.stubGlobal("_$HY", { r: {}, completed: new WeakSet(), events: [] }); }
  const ssrNodes = elements(root, "*");
  const attributes = (nodes: Element[]) => nodes.map(node => Array.from(node.attributes).filter(attr => attr.name !== "_hk").map(attr => [attr.name, attr.value]));
  const ssrAttributes = attributes(ssrNodes), ssrText = root.textContent;
  const mounted = client.mountProgress(root, initial, hydrating);
  disposers.push(() => { mounted.dispose(); root.remove(); });
  if (hydrating) { expect(elements(root, "*")).toEqual(ssrNodes); expect(attributes(elements(root, "*"))).toEqual(ssrAttributes); expect(root.textContent).toBe(ssrText); }
  const rows = elements(root, "li", "data-queue-item"), bars = elements(root, "progress");
  expect(rows).toHaveLength(5);
  expect(bars[1].getAttribute("value")).toBe(String(15 * mb)); expect(bars[1].getAttribute("max")).toBe(String(90 * mb));
  expect(bars[1].getAttribute("aria-valuetext")).toBe("已写入 15.0 / 90.0 MB · 4.8 MB/s · 剩余约 16 秒");
  expect(bars[2].hasAttribute("value")).toBe(false); expect(bars[2].getAttribute("aria-valuetext")).toContain("估计");
  expect(bars[3].getAttribute("value")).toBe(String(2 * mb)); expect(bars[3].getAttribute("max")).toBe(String(5 * mb));
  expect(bars[3].getAttribute("aria-valuetext")).toBe("已下载 2.0 / 5.0 MB · 1.0 MB/s · 剩余约 3 秒");
  expect(bars[4].hasAttribute("value")).toBe(false); expect(bars[4].getAttribute("aria-valuetext")).toContain("总大小未知");
  expect(withClass(root, "kindle-queue-summary").textContent).toBe("共 5 本 · 已完成 1 · 已写入 45.0 / 120.0 MB（另 3 本待转换）");
  const live = elements(root, "span", "aria-live"), announcements = live.map(node => node.textContent), liveChildren = live.map(node => Array.from(node.childNodes));
  expect(live).toHaveLength(5); expect(live.every(node => node.getAttribute("aria-live") === "polite" && node.getAttribute("aria-atomic") === "true")).toBe(true);
  expect(elements(root, "p").every(node => !node.hasAttribute("role"))).toBe(true);
  const next = initial.map(value => value.id === "write" ? { ...value, loaded: 20 * mb, writtenBytes: 20 * mb, etaSeconds: 14 } : value.id === "convert" ? { ...value, message: "正在转换 KFX · 已用 1.3 秒 · 预计剩余约 1 秒（估计）" } : value);
  mounted.update(next);
  expect(elements(root, "li", "data-queue-item")).toEqual(rows); expect(elements(root, "progress")).toEqual(bars);
  expect(elements(root, "span", "aria-live")).toEqual(live); expect(live.map(node => node.textContent)).toEqual(announcements);
  expect(live.map(node => Array.from(node.childNodes))).toEqual(liveChildren);
  expect(bars[1].getAttribute("value")).toBe(String(20 * mb));
  expect(withClass(root, "kindle-queue-summary").textContent).toContain("已写入 50.0 / 120.0 MB");
  mounted.update(next.map(value => value.id === "write" ? { ...value, phase: "finalize", message: "正在完成写入", loaded: value.total } : value));
  expect(bars[1].hasAttribute("value")).toBe(false); expect(bars[1].getAttribute("aria-valuetext")).toBe("正在完成写入");
  expect(live[1].textContent).toBe("书籍 write：正在完成写入");
  mounted.update(next.map(value => value.id === "write" ? { ...value, state: "失败", message: "Kindle 已断开，请重新插入后重试", writtenBytes: 0 } : value));
  expect(live[1].textContent).toContain("失败：Kindle 已断开"); expect(bars[1].getAttribute("value")).toBe("0");
  expect(withClass(root, "kindle-queue-summary").textContent).toContain("已写入 30.0 / 120.0 MB");
});

it("carries streaming Content-Length through the real queue into download rows and the batch summary", async () => {
  const c = await connected(), total = 10867355, chunkSize = 1024 * 1024;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const response = new Response(stream, { headers: { "Content-Length": String(total) } });
  let deliver!: (response: Response) => void;
  const convert = vi.fn(async () => { throw new Error("download must be cancelled first"); });
  const queue = new TransferQueue(new KindleTransferService({
    fetch: () => new Promise<Response>(resolve => { deliver = resolve; }),
    converter: { convert }, profile: async deviceId => defaultProfile(deviceId), thumbnail: async () => new Uint8Array(),
  }));
  const m = mount("transfer", { ...c.input, queue }); await settle(m);
  const id = queue.enqueue(c.device, "a".repeat(32));
  try {
    await settle(m);
    expect(queue.snapshot()[0]).toMatchObject({ phase: "download", loaded: undefined, total: undefined });
    expect(withClass(m.root, "kindle-progress-detail").textContent).toBe("正在读取书库 EPUB");
    deliver(response); await settle(m);
    expect(queue.snapshot()[0]).toMatchObject({ phase: "download", loaded: 0, total, downloadedBytes: 0, downloadTotal: total });
    const bar = elements(m.root, "progress")[0];
    expect(bar.getAttribute("max")).toBe(String(total));
    expect(bar.getAttribute("aria-valuetext")).toBe("已下载 0.0 / 10.4 MB");
    const now = Date.now.bind(Date); vi.spyOn(Date, "now").mockImplementation(() => now() + 120);
    controller.enqueue(new Uint8Array(chunkSize)); await settle(m);
    expect(queue.snapshot()[0]).toMatchObject({ phase: "download", loaded: chunkSize, total, downloadedBytes: chunkSize, downloadTotal: total });
    expect(bar.getAttribute("value")).toBe(String(chunkSize));
    expect(bar.getAttribute("aria-valuetext")).toContain("已下载 1.0 / 10.4 MB");
    expect(withClass(m.root, "kindle-queue-summary").textContent).toBe("共 1 本 · 已完成 0 · 已下载 1.0 / 10.4 MB");
  } finally { deliver(response); queue.cancel(id); await settle(m); }
  expect(convert).not.toHaveBeenCalled();
});

it("renders the connection title, four numbered steps and remembered-device sidebar in SSR", () => {
  const root = document.createElement("div"); root.innerHTML = server.markup("connect", input());
  const connection = withClass(root, "kindle-connect"), steps = withClass(connection, "kindle-steps");
  expect(elements(connection, "h1").map(node => node.textContent)).toEqual(["连接你的设备"]);
  expect(steps.tagName).toBe("ol"); expect(elements(steps, "li")).toHaveLength(4);
  // The Kindle model choice appears only after an unpaired Kindle root is picked.
  expect(elements(steps, "input").filter(node => node.getAttribute("type") === "radio")).toHaveLength(0);
  const picker = button(connection, "选择设备目录"); expect(picker.hasAttribute("disabled")).toBe(true);
  const nodes = elements(connection, "*"); expect(nodes.indexOf(steps)).toBeLessThan(nodes.indexOf(picker));
  expect(elements(connection, "aside")[0]!.getAttribute("aria-label")).toBe("记住的设备");
  expect(elements(connection, "h2")[0]!.textContent).toBe("记住的设备");
});

it.each(["books", "connect", "transfer"] as const)("hydrates neutral SSR for %s, restores the device, then updates after unplug/replug", async page => {
  const c = await connected([record("a", "a.kfx")]);
  // Even a populated client manager must not change the first render.
  await c.manager.restore(saved(c.device));
  const html = server.markup(page, c.input);
  expect(html).toContain("检测中…"); expect(html).not.toContain("我的 Paperwhite");
  const m = mount(page, c.input), ssrBar = elements(m.root, "section", "data-kindle-device-bar")[0];
  await settle(m); expect(text(m)).toContain("我的 Paperwhite"); expect(text(m)).toContain("1072×1448"); expect(text(m)).toContain("Kindle 5.16.2.1.1");
  expect(elements(m.root, "section", "data-kindle-device-bar")[0]).toBe(ssrBar);
  if (page === "books") expect(elements(m.root, "tr", "data-device-book")).toHaveLength(1);
  if (page === "transfer") expect(elements(m.root, "li", "data-transfer-book").map(b => b.getAttribute("data-transfer-book"))).toEqual(["b"]);
  if (page === "connect") expect(elements(m.root, "div", "data-remembered-device")).toHaveLength(1);
  c.fs.unplug(); await c.manager.probe(); await settle(m); expect(text(m)).toContain("已断开"); expect(text(m)).not.toContain("已枚举文件");
  if (page === "books") expect(elements(m.root, "tr", "data-device-book")).toHaveLength(0);
  c.fs.plug(); await c.manager.probe(); await settle(m); expect(text(m)).toContain("已连接"); expect(text(m)).toContain("已枚举文件");
});

it("shows unsupported-browser guidance only after hydration", async () => {
  globals(false); const m = mount("connect", input());
  await settle(m); expect(text(m)).toContain("此浏览器不支持设备磁盘访问"); expect(text(m)).toContain("Edge 或 Chrome");
  expect(button(m.root, "选择设备目录").hasAttribute("disabled")).toBe(true);
});

it("pairs a selected root with the chosen model/name and forgets only the browser record", async () => {
  const fs = await fakeKindle(), manager = new KindleDeviceManager(repository(), async () => fs.root), m = mount("connect", input(manager));
  await settle(m);
  expect(elements(m.root, "input").some(el => el.getAttribute("value") === "KO3")).toBe(false);
  fire(button(m.root, "选择设备目录"), "click"); await settle(m); expect(text(m)).toContain("完成首次配对");
  expect(elements(m.root, "input").filter(el => el.getAttribute("type") === "radio").map(el => el.getAttribute("value"))).toEqual(["KPW3", "KO3", "other"]);
  const ko3 = elements(m.root, "input").find(el => el.getAttribute("value") === "KO3")!; fire(ko3, "change"); m.flush();
  const name = field(m.root, "显示名称"); name.value = "我的 Oasis"; fire(name, "input"); m.flush();
  fire(elements(m.root, "form")[0]!, "submit"); await settle(m);
  expect(JSON.parse(await fs.text(".bindery/device.json"))).toMatchObject({ model: "KO3", name: "我的 Oasis" }); expect(text(m)).toContain("1264×1680");
  fire(button(m.root, "忘记"), "click"); await settle(m); expect(await manager.remembered()).toEqual([]); expect(text(m)).toContain("未配对或未选择设备");
  expect(JSON.parse(await fs.text(".bindery/device.json"))).toMatchObject({ name: "我的 Oasis" });
});

it("requests remembered-device permission directly in the click before restoring, and explains denial", async () => {
  const c = await connected(); c.fs.permission = "prompt"; c.fs.requestResult = "denied";
  const request = vi.spyOn(c.fs.root, "requestPermission"), m = mount("connect", c.input); await settle(m);
  expect(text(m)).toContain("需要授权"); fire(button(m.root, "授权"), "click"); expect(request).toHaveBeenCalledOnce();
  await settle(m); expect(text(m)).toContain("已拒绝"); expect(text(m)).toContain("站点设置");
  c.fs.requestResult = "granted"; fire(button(m.root, "授权 / 选择"), "click"); expect(request).toHaveBeenCalledTimes(2);
  await settle(m); expect(text(m)).toContain("已连接");
});

it("reports invalid directory selection and ignores user cancellation", async () => {
  let fail = true; const manager = new KindleDeviceManager(repository(), async () => { if (fail) throw new Error("请选择 Kindle 磁盘根目录"); throw new DOMException("cancel", "AbortError"); });
  const m = mount("connect", input(manager)); await settle(m); fire(button(m.root, "选择设备目录"), "click"); await settle(m);
  expect(text(m)).toContain("请选择 Kindle 磁盘根目录"); fail = false; fire(button(m.root, "选择设备目录"), "click"); await settle(m); expect(m.context().error()).toBe("");
});

it("filters device books using library metadata and filename fallback, including the empty state", async () => {
  const c = await connected([record("a", "a.kfx", "wide")]); await c.fs.write("documents/陌生的书.azw3", "other");
  const m = mount("books", c.input); await settle(m); expect(text(m)).toContain("书库甲"); expect(text(m)).toContain("陌生的书"); expect(text(m)).toContain("宽边距");
  fire(button(m.root, "其他 1"), "click"); m.flush(); expect(elements(m.root, "tr", "data-device-book").map(n => n.getAttribute("data-device-book"))).toEqual(["陌生的书.azw3"]);
  fire(button(m.root, "全部"), "click"); m.flush(); const search = field(m.root, "搜索设备上的书"); search.value = "作者"; fire(search, "input"); m.flush(); expect(elements(m.root, "tr", "data-device-book")).toHaveLength(1);
  search.value = "不存在"; fire(search, "input"); m.flush(); expect(elements(m.root, "tr", "data-device-book")).toHaveLength(0); expect(text(m)).toContain("没有符合条件的书籍");
});

it("confirms selected deletion, removes the matching sidecar/record/thumbnail, and refreshes usage", async () => {
  const r = record("a", "a.kfx"); r.thumbnail = "thumbnail_id_a_EBOK_portrait.jpg";
  const c = await connected([r]); await c.fs.write("documents/a.sdr/reading-position", "position"); await c.fs.write(`system/thumbnails/${r.thumbnail}`, "jpeg"); await c.fs.write("documents/other.txt", "other");
  const m = mount("books", c.input); await settle(m); const checkbox = field(m.root, "选择 书库甲"); checkbox.checked = true; fire(checkbox, "change"); m.flush();
  fire(button(m.root, "删除所选（1）"), "click"); m.flush(); expect(text(m)).toContain(".sdr 文件夹"); expect(text(m)).toContain("此操作无法撤销");
  expect((elements(m.root, "dialog")[0] as HTMLDialogElement).open).toBe(true); fire(button(m.root, "确认删除"), "click"); await settle(m);
  await expect(c.fs.bytes("documents/a.kfx")).rejects.toMatchObject({ name: "NotFoundError" }); await expect(c.fs.bytes("documents/a.sdr/reading-position")).rejects.toMatchObject({ name: "NotFoundError" }); await expect(c.fs.bytes(`system/thumbnails/${r.thumbnail}`)).rejects.toMatchObject({ name: "NotFoundError" });
  expect(JSON.parse(await c.fs.text(".bindery/manifest.json")).books).toEqual([]); expect(elements(m.root, "tr", "data-device-book").map(n => n.getAttribute("data-device-book"))).toEqual(["other.txt"]); expect(m.context().inventory()!.usage.books).toBe(5);
});

it("clears old inventory and selection when switching devices and prevents deletion against the new device", async () => {
  const a = await connected([record("a", "a.kfx")]), b = await connected([record("b", "a.kfx")]);
  const m = mount("books", a.input); await settle(m); const checkbox = field(m.root, "选择 书库甲"); checkbox.checked = true; fire(checkbox, "change"); m.flush(); fire(button(m.root, "删除所选（1）"), "click"); m.flush();
  await a.manager.restore(saved(b.device)); await settle(m); expect((elements(m.root, "dialog")[0] as HTMLDialogElement).open).toBe(false); expect(button(m.root, "删除所选（0）")).toBeDefined();
  expect(text(m)).toContain("书库乙"); expect(await b.fs.text("documents/a.kfx")).toBe("BOOK");
});

it("enqueues a retransmission with the recorded profile and overwrite enabled", async () => {
  const c = await connected([record("a", "a.kfx", "wide")]); const transfer = vi.fn(async () => { throw new Error("profile was removed"); }); c.input.queue = new TransferQueue({ transferBook: transfer });
  const m = mount("books", c.input); await settle(m); const href = elements(m.root, "a").find(a => a.getAttribute("aria-label") === "预览 书库甲")?.getAttribute("href"); expect(href).toBe("/devices/preview?book=a");
  const row = elements(m.root, "tr", "data-device-book")[0]!, actions = withClass(row, "kindle-row-actions");
  expect(Array.from(actions.childNodes).filter(node => node.nodeType === 1).map(node => (node as Element).getAttribute("aria-label")))
    .toEqual(["预览 书库甲", "重新传入 书库甲", "从设备删除 书库甲"]);
  expect(elements(actions, "svg")).toHaveLength(3);
  for (const icon of elements(actions, "svg")) expect(icon.getAttribute("aria-hidden")).toBe("true");
  for (const index of [3, 5, 6]) expect(elements(row, "td")[index]!.className).toContain("kindle-mono");
  fire(button(m.root, "重新传入 书库甲"), "click"); await settle(m); expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ identity: c.device.identity }), "a", "wide", expect.objectContaining({ overwrite: true }));
  expect(text(m)).toContain("已加入传输队列：书库甲");
});

it("loads device profiles, applies library filters/search and preserves selection across paging", async () => {
  const c = await connected([record("a", "a.kfx")]); c.input.books = [book("a", "书库甲"), book("b", "书库乙", true), ...Array.from({ length: 26 }, (_, i) => book(`x${i}`, `未读 ${i}`))];
  c.input.loadProfiles = vi.fn(async id => [defaultProfile(id), { ...defaultProfile(id), id: "wide", name: "宽边距", builtIn: false }]);
  const m = mount("transfer", c.input); await settle(m); expect(c.input.loadProfiles).toHaveBeenCalledWith(c.device.identity.id); expect(elements(m.root, "option").map(n => n.textContent)).toContain("宽边距");
  expect(elements(m.root, "li", "data-transfer-book")).toHaveLength(24); expect(text(m)).not.toContain("已在设备");
  await c.manager.probe(); await settle(m); expect(c.input.loadProfiles).toHaveBeenCalledOnce();
  const checkbox = field(m.root, "选择 书库乙"); checkbox.checked = true; fire(checkbox, "change"); m.flush(); fire(button(m.root, "下一页"), "click"); m.flush(); expect(text(m)).toContain("已选 1 本");
  await c.manager.probe(); await settle(m); expect(text(m)).toContain("已选 1 本");
  fire(button(m.root, "未读"), "click"); m.flush(); expect(elements(m.root, "li", "data-transfer-book").map(n => n.getAttribute("data-transfer-book"))).not.toContain("b"); expect(text(m)).toContain("已在设备");
  const search = field(m.root, "搜索书库"); search.value = "书库甲"; fire(search, "input"); m.flush(); expect(elements(m.root, "li", "data-transfer-book")).toHaveLength(1); expect(text(m)).toContain("估计大小：待转换后确定");
});

it("keeps the queue running while moving among Kindle pages, supports cancel and clear, and renders notices", async () => {
  const c = await connected(); let reject!: (e: Error) => void;
  const transfer = vi.fn((_device: PairedDevice, _book: string, _profile: string, options: TransferOptions = {}) => new Promise<ManifestBook>((_resolve, r) => { reject = r; options.signal?.addEventListener("abort", () => r(new DOMException("cancel", "AbortError"))); options.progress?.({ state: "转换", phase: "convert", message: "正在转换 KFX", startedAt: Date.now(), phaseStartedAt: Date.now() }); }));
  c.input.queue = new TransferQueue({ transferBook: transfer });
  const m = mount("transfer", c.input); await settle(m); const checkbox = field(m.root, "选择 书库甲"); checkbox.checked = true; fire(checkbox, "change"); m.flush(); fire(button(m.root, "开始传输（1）"), "click"); await settle(m);
  expect(text(m)).toContain("正在转换 KFX"); expect(transfer).toHaveBeenCalledOnce(); const context = m.context(); m.page("books"); await settle(m); m.page("connect"); await settle(m); m.page("transfer"); await settle(m);
  expect(m.context()).toBe(context); expect(transfer).toHaveBeenCalledOnce(); expect(text(m)).toContain("正在转换 KFX");
  fire(button(m.root, "取消"), "click"); await settle(m); expect(text(m)).toContain("失败"); expect(text(m)).toContain("操作已取消");
  fire(button(m.root, "清除已结束"), "click"); m.flush(); expect(elements(m.root, "li", "data-queue-item")).toHaveLength(0);
  expect(text(m)).toContain("GPL-3.0-or-later"); expect(text(m)).toContain("GNU GENERAL PUBLIC LICENSE"); expect(elements(m.root, "a").some(a => a.getAttribute("href") === "https://crates.io/api/v1/crates/boko/0.5.0/download")).toBe(true);
  reject(new Error("already cancelled"));
});

it("uses the selected profile and overwrite setting, shows failure, and retries profile loading", async () => {
  const c = await connected([record("a", "a.kfx")]); const transfer = vi.fn(async () => { throw new Error("Kindle 空间不足"); }); c.input.queue = new TransferQueue({ transferBook: transfer });
  let fail = true; c.input.loadProfiles = async id => { if (fail) throw new Error("配置服务暂时不可用"); const profile = defaultProfile(id); return [{ ...profile, id: "wide", name: "宽边距", builtIn: false, settings: { ...profile.settings, stripFonts: true, stripImages: true } }]; };
  const m = mount("transfer", c.input); await settle(m); expect(text(m)).toContain("配置服务暂时不可用"); fail = false; fire(button(m.root, "重试"), "click"); await settle(m);
  fire(button(m.root, "全部"), "click"); m.flush(); const select = elements(m.root, "label").find(label => label.firstChild?.textContent === "排版方案")!.getElementsByTagName("select")[0] as HTMLSelectElement; select.value = "wide"; fire(select, "change"); m.flush(); const overwrite = elements(m.root, "input").find(el => el.getAttribute("type") === "checkbox" && el.parentNode?.textContent === "覆盖设备上的同名书") as HTMLInputElement; overwrite.checked = true; fire(overwrite, "change"); m.flush();
  expect(elements(m.root, "p", "data-profile-summary")[0]!.textContent).toBe("去掉书籍自带字体 · 去掉所有图片（保留封面）");
  const checkbox = field(m.root, "选择 书库甲"); checkbox.checked = true; fire(checkbox, "change"); m.flush(); expect(text(m)).toContain("约 4 B（按设备已有副本）"); fire(button(m.root, "开始传输（1）"), "click"); await settle(m);
  expect(transfer).toHaveBeenCalledWith(expect.anything(), "a", "wide", expect.objectContaining({ overwrite: true })); expect(text(m)).toContain("Kindle 空间不足");
});

it("refreshes inventory after queue completion and exposes accurate enumerated usage", async () => {
  const c = await connected(); const transfer = vi.fn(async () => { const r = record("a", "a.kfx"); await c.fs.write("documents/a.kfx", "BOOK"); await c.fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: [r] })); return r; }); c.input.queue = new TransferQueue({ transferBook: transfer });
  const m = mount("transfer", c.input); await settle(m); const checkbox = field(m.root, "选择 书库甲"); checkbox.checked = true; fire(checkbox, "change"); m.flush(); fire(button(m.root, "开始传输（1）"), "click"); await settle(m);
  expect(text(m)).toContain("已传入 Kindle"); expect(m.context().inventory()!.usage.books).toBe(4); expect(m.context().inventory()!.usage.capacity).toBeNull(); expect(elements(m.root, "li", "data-transfer-book").map(n => n.getAttribute("data-transfer-book"))).toEqual(["b"]);
});

it("surfaces inventory failures and can recover through an explicit recheck", async () => {
  const c = await connected(); let fail = true; c.fs.beforeOperation = op => { if (fail && op.operation === "values" && op.path === "/documents") throw new Error("设备目录无法读取"); };
  const m = mount("books", c.input); await settle(m); expect(text(m)).toContain("设备目录无法读取"); fail = false; fire(button(m.root, "重新检测"), "click"); await settle(m); expect(text(m)).toContain("设备上还没有书籍"); expect(m.context().inventoryError()).toBe("");
});

it("keeps the device connected and shows a quiet expandable unreadable-path notice", async () => {
  const c = await connected([record("a", "a.kfx")]), stem = "x".repeat(120);
  const path = `documents/a.sdr/${stem}${stem}.yjr`;
  await c.fs.write(path, "unreadable"); c.fs.windowsPathLimit = 260;
  const m = mount("books", c.input); await settle(m);
  expect(m.context().state().status).toBe("granted"); expect(text(m)).toContain("已连接"); expect(text(m)).not.toContain("Kindle 已断开");
  const details = elements(m.root, "details", "data-unreadable-notice")[0]!;
  expect(details.textContent).toContain("有 1 个条目无法读取"); expect(details.textContent).toContain("已跳过统计"); expect(details.textContent).toContain(path); expect(details.textContent).toContain("260");
  expect(details.hasAttribute("open")).toBe(false); expect(details.getAttribute("role")).not.toBe("alert");
  expect(m.context().inventory()!.books.map(b => b.filename)).toEqual(["a.kfx"]); expect(m.context().inventoryError()).toBe("");
});

it("reports precisely which sidecar paths could not be removed after successful book deletion", async () => {
  const r = record("a", "a.kfx"); r.thumbnail = "thumbnail_id_a_EBOK_portrait.jpg";
  const c = await connected([r]); await c.fs.write("documents/a.sdr/blocked", "keep"); await c.fs.write("documents/a.sdr/after", "remove"); await c.fs.write(`system/thumbnails/${r.thumbnail}`, "jpeg");
  c.fs.injectFailure("getFile", "documents/a.sdr/blocked"); c.fs.injectFailure("remove", "documents/a.sdr/blocked");
  const m = mount("books", c.input); await settle(m);
  fire(button(m.root, "从设备删除 书库甲"), "click"); m.flush(); fire(button(m.root, "确认删除"), "click"); await settle(m);
  const report = elements(m.root, "details", "data-delete-report")[0]!;
  expect(report.textContent).toContain("书籍文件已删除"); expect(report.textContent).toContain("documents/a.sdr/blocked"); expect(report.textContent).not.toContain("documents/a.sdr/after");
  expect(report.textContent).toContain("设备本机"); expect(report.textContent).toContain("支持长路径的工具"); expect(report.textContent).toContain("NotFoundError");
  expect(m.context().state().status).toBe("granted"); expect(text(m)).toContain("已删除 1 本设备书籍"); expect((elements(m.root, "dialog")[0] as HTMLDialogElement).open).toBe(false);
  expect(JSON.parse(await c.fs.text(".bindery/manifest.json")).books).toEqual([]);
  for (const path of ["documents/a.kfx", "documents/a.sdr/after", `system/thumbnails/${r.thumbnail}`]) await expect(c.fs.bytes(path)).rejects.toMatchObject({ name: "NotFoundError" });
});

it("retries only remaining books after a partially successful bulk deletion", async () => {
  const c = await connected([record("a", "a.kfx"), record("b", "b.kfx")]);
  const m = mount("books", c.input); await settle(m);
  const selectAll = field(m.root, "全选当前筛选书籍"); selectAll.checked = true; fire(selectAll, "change"); m.flush();
  fire(button(m.root, "删除所选（2）"), "click"); m.flush();
  let fail = true;
  c.fs.beforeOperation = op => { if (fail && op.operation === "remove" && op.path === "/documents/b.kfx") { fail = false; throw new Error("删除暂时失败，请重试"); } };
  fire(button(m.root, "确认删除"), "click"); await settle(m);
  expect(text(m)).toContain("删除暂时失败，请重试"); expect(m.context().inventory()!.books.map(b => b.filename)).toEqual(["b.kfx"]);
  expect(elements(m.root, "dialog")[0]!.textContent).toContain("所选 1 本书");
  fire(button(m.root, "确认删除"), "click"); await settle(m);
  expect(m.context().inventory()!.books).toEqual([]); expect((elements(m.root, "dialog")[0] as HTMLDialogElement).open).toBe(false);
});

it("loads device thumbnails and revokes their object URLs when leaving the books page", async () => {
  const r = record("a", "a.kfx"); r.thumbnail = "thumbnail_id_a_EBOK_portrait.jpg";
  const c = await connected([r]); await c.fs.write(`system/thumbnails/${r.thumbnail}`, "JPEG");
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:kindle-cover"), revoke = vi.spyOn(URL, "revokeObjectURL");
  const m = mount("books", c.input); await settle(m); expect(create).toHaveBeenCalledOnce(); expect(elements(m.root, "img").map(el => el.getAttribute("src"))).toContain("blob:kindle-cover");
  m.page("connect"); await settle(m); expect(revoke).toHaveBeenCalledWith("blob:kindle-cover");
});

it("loads every library query page and deduplicates records before exposing the picker", async () => {
  const load = vi.fn(async (page: number) => ({ books: page === 1 ? [book("a"), book("b")] : [book("b"), book("c")], total_pages: 2 }) as LibraryPageData);
  expect((await loadKindleLibrary(load)).map(b => b.book_id)).toEqual(["a", "b", "c"]); expect(load.mock.calls).toEqual([[1], [2]]);
});

it("renders Kobo transfer controls without Kindle-only settings or licenses", async () => {
  const c = await connectedKobo(); const m = mount("transfer", c.input); await settle(m);
  expect(text(m)).toContain("我的 Libra 2"); expect(text(m)).toContain("Kobo");
  expect(text(m)).toContain("去掉书籍自带字体"); expect(text(m)).toContain("去掉所有图片（保留封面）");
  expect(text(m)).not.toContain("排版方案"); expect(text(m)).not.toContain("boko"); expect(text(m)).not.toContain("GPL-3.0");
  expect(text(m)).not.toContain("documents/"); expect(text(m)).not.toContain(".sdr"); expect(text(m)).not.toContain("KFX");
  expect(elements(m.root, "li", "data-transfer-book")).toHaveLength(2);
  expect(elements(m.root, "option").some(node => node.textContent === "默认（只用书籍自带样式）")).toBe(false);
});

it("marks Kobo library sources and only allows deleting Bindery-managed KEPUBs", async () => {
  const c = await connectedKobo(["Bindery/书库甲.kepub.epub", "Other/外部.epub"]); const m = mount("books", c.input); await settle(m);
  expect(elements(m.root, "tr", "data-device-book").map(n => n.getAttribute("data-device-book"))).toEqual(["Bindery/书库甲.kepub.epub", "Other/外部.epub"]);
  expect(text(m)).toContain("来自 Bindery"); expect(text(m)).toContain("其他");
  expect(button(m.root, "从设备删除 书库甲").hasAttribute("disabled")).toBe(false);
  expect(button(m.root, "从设备删除 外部").hasAttribute("disabled")).toBe(true);
  expect(text(m)).toContain("读取 Bindery/ 与设备上的 EPUB / KEPUB");
  expect(text(m)).not.toContain("documents/"); expect(text(m)).not.toContain(".sdr"); expect(text(m)).not.toContain("缩略图");
  fire(button(m.root, "从设备删除 书库甲"), "click"); m.flush(); expect(text(m)).toContain("设备下次连接或重启时会更新书架");
  fire(button(m.root, "确认删除"), "click"); await settle(m);
  await expect(c.fs.bytes("Bindery/书库甲.kepub.epub")).rejects.toMatchObject({ name: "NotFoundError" });
  expect(await c.fs.text("Other/外部.epub")).toBe("BOOK");
});

it("detects a Kobo with an unknown product ID and still permits pairing", async () => {
  const fs = await fakeKobo("N999"), manager = new KindleDeviceManager(repository(), async () => fs.root), m = mount("connect", input(manager)); await settle(m);
  fire(button(m.root, "选择设备目录"), "click"); await settle(m);
  expect(text(m)).toContain("已识别：Kobo · Kobo（未知型号）"); expect(text(m)).toContain("型号代码 N999"); expect(text(m)).toContain("产品 UUID 00000000-0000-0000-0000-000000000388");
  expect(text(m)).not.toContain("documents/"); expect(text(m)).not.toContain("system/thumbnails"); expect(text(m)).not.toContain("KFX");
  const name = field(m.root, "显示名称"); name.value = "未知 Kobo"; fire(name, "input"); m.flush();
  fire(elements(m.root, "form")[0]!, "submit"); await settle(m);
  expect(JSON.parse(await fs.text(".bindery/device.json"))).toMatchObject({ kind: "kobo", model: "unknown", name: "未知 Kobo" });
});

it("restores the single currently connected device and prefers the last-used device when several are connected", async () => {
  const { kindle, a, b } = await twoDevices(); kindle.unplug();
  const repo = repository([saved(a), saved(b)]), preference = new MemoryDevicePreference(a.identity.id);
  const single = mount("books", input(new KindleDeviceManager(repo, undefined, preference))); await settle(single);
  expect(single.context().state().device?.identity.id).toBe(b.identity.id);
  expect(preference.get()).toBe(b.identity.id);

  kindle.plug();
  const multiplePreference = new MemoryDevicePreference(b.identity.id);
  const multiple = mount("books", input(new KindleDeviceManager(repo, undefined, multiplePreference))); await settle(multiple);
  expect(multiple.context().state().device?.identity.id).toBe(b.identity.id);
  expect(multiplePreference.get()).toBe(b.identity.id);
});

it("restores the last-used disconnected device when none are connected, without prompting", async () => {
  const { kindle, kobo, a, b } = await twoDevices(); kindle.unplug(); kobo.unplug();
  const request = vi.spyOn(kobo.root, "requestPermission"), preference = new MemoryDevicePreference(b.identity.id);
  const m = mount("books", input(new KindleDeviceManager(repository([saved(a), saved(b)]), undefined, preference))); await settle(m);
  expect(m.context().state().device?.identity.id).toBe(b.identity.id);
  expect(m.context().state().status).toBe("disconnected");
  expect(request).not.toHaveBeenCalled();
  expect(preference.get()).toBe(b.identity.id);
});

it("switches in place from the device bar, persists the choice and restores it on the next mount", async () => {
  const { a, b } = await twoDevices(), repo = repository([saved(a), saved(b)]), preference = new MemoryDevicePreference(a.identity.id);
  const m = mount("books", input(new KindleDeviceManager(repo, undefined, preference))); await settle(m);
  expect(m.context().state().device?.identity.id).toBe(a.identity.id);
  const select = elements(m.root, "select").find(node => node.getAttribute("aria-label") === "切换当前设备")!;
  expect(elements(select, "option").map(node => node.textContent)).toEqual([
    "当前设备",
    "Kindle A · Kindle Paperwhite 3 · 已连接",
    "Kobo B · Kobo Libra 2 · 已连接",
  ]);
  (select as HTMLSelectElement).value = b.identity.id; fire(select, "change"); await settle(m);
  expect(m.context().state().device?.identity.id).toBe(b.identity.id);
  expect(preference.get()).toBe(b.identity.id);
  expect((select as HTMLSelectElement).value).toBe(b.identity.id);

  const next = mount("books", input(new KindleDeviceManager(repo, undefined, preference))); await settle(next);
  expect(next.context().state().device?.identity.id).toBe(b.identity.id);
});
