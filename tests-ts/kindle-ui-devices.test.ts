import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { binderyIcons } from "../scripts/vite-icons";
import solid from "vite-plugin-solid";
import { solidOptions } from "../scripts/solid-options";
import { KindleDeviceManager } from "../src/client/kindle/device";
import { pairDevice, type PairedDevice } from "../src/client/kindle/identity";
import { TransferQueue, type TransferItem } from "../src/client/kindle/queue";
import { defaultProfile, EMPTY_SETTINGS, type TypesettingProfile } from "../src/client/devices/profiles";
import type { DeviceKind } from "../src/client/devices/models";
import type { DeviceReadingSettings } from "../src/client/devices/typeset";
import type { ManifestBook } from "../src/client/kindle/manifest";
import type { RememberedDevice } from "../src/client/kindle/remembered";
import { KindleTransferService, type TransferOptions } from "../src/client/kindle/transfer";
import type { KindleContextValue } from "../src/features/kindle/context";
import type { KindleLibraryBook } from "../src/features/kindle/devices/library";
import { loadKindleLibrary } from "../src/features/kindle/devices/library";
import type { LibraryPageData } from "../src/server/library/queries";
import { fakeKindle, fakeKobo } from "./support/fake-fs";
import { lprStore, miniKfx, positionString } from "./support/kindle-reading";
import { detectDevice, pairDetectedDevice } from "../src/client/devices/identity";
import { MemoryDevicePreference } from "../src/client/devices/preferences";
import { clientDocument, elements, fire } from "./support/client-dom";
import { allByAttribute, allByRole, byAttribute, byLabel, byRole, byText } from "./support/queries";
import type { DeviceBook } from "../src/client/devices/inventory";
import type { LoadDevicePageSample } from "../src/features/devices/reading-page";
import { bookFingerprint } from "../src/core/fingerprint";

type Page = "books" | "connect" | "transfer";
interface SyncResult { synced: number; skipped: number; marked_read: number; unchanged: number; kept: number; lagged: boolean; unmatched: number }
interface Input { manager: KindleDeviceManager; queue: TransferQueue; books: KindleLibraryBook[]; loadProfiles: (id: string) => Promise<TypesettingProfile[]>; reading?: { get: (deviceId: string, kind: DeviceKind) => Promise<DeviceReadingSettings>; save: (deviceId: string, kind: DeviceKind, settings: DeviceReadingSettings) => Promise<unknown> }; preselected?: string[]; syncKobo?: (device: PairedDevice) => Promise<SyncResult>; syncKindle?: (device: PairedDevice) => Promise<SyncResult>; chapters?: (deviceId: string) => Promise<Record<string, string>> }
interface Mounted { context(): KindleContextValue; page(page: Page): void; books(books: KindleLibraryBook[]): void; flush(): void; dispose(): void }
interface SampleInput { deviceId: string; book: DeviceBook; model: string; revision?: string; load: LoadDevicePageSample }
interface Probe {
  mountSample(root: HTMLElement, input: SampleInput): { update(input: SampleInput): void; flush(): void; dispose(): void };
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
import { KindleTransferPage, KindleTransferQueueProgress, queueSummary } from '${resolve("src/features/kindle/devices/transfer")}';
import { ReadingPage } from '${resolve("src/features/devices/reading-page")}';
export function mountSample(root, input) {
  const [props, setProps] = createSignal(input);
  const dispose = render(() => <ReadingPage {...props()} kind="kobo" />, root);
  return { update(next) { setProps(next); flush(); }, flush, dispose };
}
function Capture(props) { props.receive(useKindle()); return null; }
function view(page, input, books, capture) {
  function child() {
    switch (page()) {
      case 'books': return <KindleBooksPage books={books()} chapters={input.chapters} />;
      case 'connect': return <KindleConnectPage />;
      case 'transfer': return <KindleTransferPage books={books()} preselected={input.preselected} loadProfiles={input.loadProfiles} reading={input.reading} />;
    }
  }
  return <Loading><KindleProvider manager={input.manager} queue={input.queue} koboReadingSync={input.syncKobo} kindleReadingSync={input.syncKindle}><Capture receive={capture} /><KindleDeviceBar />{child()}</KindleProvider></Loading>;
}
export function markup(page, input) { return renderToString(() => view(() => page, input, () => input.books, () => {})); }
export function mount(root, initial, input, hydrating) {
  let context;
  const [page, setPage] = createSignal(initial), [books, setBooks] = createSignal(input.books);
  const dispose = (hydrating ? hydrate : render)(() => view(page, input, books, k => context = k), root);
  return { context: () => context, page(next) { setPage(next); flush(); }, books(next) { setBooks(next); flush(); }, flush, dispose };
}
const queueView = items => <><p class="kindle-queue-summary">{queueSummary(items())}</p><KindleTransferQueueProgress items={items()} title={id => '书籍 ' + id} deviceName={() => 'KPW3'} currentDeviceId="kpw3" cancel={() => {}} /></>;
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
  Object.defineProperty(Object.getPrototypeOf(doc.createElement("div")), "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, bottom: 30, width: 200, height: 30, right: 200 }) });
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
    const result = await build({ configFile: false, logLevel: "silent", plugins: [...binderyIcons(),
      // These tests inject the profile API and queue service. Never bundle server-only RPC handlers into Node-tree DOM probes.
      { name: "kindle-ui-rpc-boundary", enforce: "pre", resolveId: (id, importer) => !importer ? undefined : id.includes("server/kindle/functions") ? "\0kindle-ui-rpc" : id.includes("server/typeset/functions") ? "\0typeset-ui-rpc" : id.includes("server/reading/functions") || id.includes("library/functions") ? "\0reading-ui-rpc" : undefined, load: id => id === "\0kindle-ui-rpc" ? "export const listKindleProfiles = async () => { throw Error('unexpected RPC in UI test') }" : id === "\0typeset-ui-rpc" ? "export const listTypesetProfiles = async () => { throw Error('unexpected RPC in UI test') }" : id === "\0reading-ui-rpc" ? "export const syncKoboReading = async () => { throw Error('unexpected RPC in UI test') }; export const loadLibrary = async () => { throw Error('unexpected RPC in UI test') }" : undefined },
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
it("reloads chapter samples after sync, ignores stale responses and falls back without a mapping", async () => {
  const root = document.createElement("div"); document.documentElement.appendChild(root);
  const pending: ((sample: Awaited<ReturnType<LoadDevicePageSample>>) => void)[] = [];
  const load = vi.fn<LoadDevicePageSample>(() => new Promise(resolve => pending.push(resolve)));
  const initial: SampleInput = { deviceId: "old", model: "libra2", book: { filename: "Bindery/book.kepub.epub", book_id: "book" } as DeviceBook, load };
  const mounted = client.mountSample(root, initial); mounted.flush();
  const settleSample = async () => { await Promise.resolve(); mounted.flush(); };
  expect(root.textContent).toContain("暂无可映射的章节样张");
  mounted.update({ ...initial, deviceId: "new" });
  pending[0]({ bookId: "book", title: "旧设备", chapter: "过期章节", path: "old.xhtml" }); await settleSample();
  expect(elements(root, "iframe")).toHaveLength(0);
  pending[1]({ bookId: "book", title: "书", chapter: "第二章", path: "chapter2.xhtml" }); await settleSample();
  const frame = elements(root, "iframe")[0]; expect(frame.getAttribute("src")).toContain("chapter2.xhtml"); expect(frame.getAttribute("sandbox")).toBe("allow-same-origin"); expect(frame.getAttribute("tabindex")).toBe("-1");
  expect(root.textContent).toContain("非真机截图");
  mounted.update({ ...initial, deviceId: "new", revision: "刚刚同步" });
  expect(load).toHaveBeenCalledTimes(3); pending[2](null); await settleSample();
  expect(elements(root, "iframe")).toHaveLength(0); expect(root.textContent).toContain("暂无可映射的章节样张");
  mounted.update({ ...initial, deviceId: "new", revision: "再次同步" }); mounted.dispose();
  pending[3]({ bookId: "book", title: "书", chapter: "第二章", path: "chapter2.xhtml" }); await settleSample();
  expect(elements(root, "iframe")).toHaveLength(0); root.remove();
});

const book = (id: string, title = id, read = false): KindleLibraryBook => ({ book_id: id, title, author: "作者", cover_url: null, read });
function repository(initial: RememberedDevice[] = []) {
  const rows = new Map(initial.map(d => [d.id, d]));
  return { list: async () => [...rows.values()], put: async (d: RememberedDevice) => { rows.set(d.id, d); }, remove: async (id: string) => { rows.delete(id); } };
}
const saved = (d: PairedDevice): RememberedDevice => ({ id: d.identity.id, identity: d.identity, root: d.root });
const record = (id: string, filename: string, profile = "default"): ManifestBook => ({ book_id: id, filename, content_id: `id_${id}`, cde_content_type: "EBOK", profile_id: profile, profile_name: profile === "default" ? "默认" : "宽边距", transferred_at: "2026-10-19T03:04:05Z", size: 4, thumbnail: null });
function input(manager = new KindleDeviceManager(repository()), books = [book("a", "书库甲"), book("b", "书库乙", true)]): Input {
  return { manager, books, queue: new TransferQueue({ transferBook: async () => { throw new Error("测试队列尚未接入转换服务"); } }), loadProfiles: async id => [defaultProfile()] };
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
function field(root: Element, label: string) { return byLabel(root, label) as HTMLInputElement; }
function selectBook(m: Mounted & { root: Element }, label: string) {
  const batch = elements(m.root, "button").find(node => node.textContent === "批量选择");
  if (batch) { fire(batch, "click"); m.flush(); }
  fire(button(m.root, label), "click"); m.flush();
}
function deleteDialog(root: Element) { return elements(root, "dialog").find(dialog => elements(dialog, "h2").some(h => h.textContent?.startsWith("删除 "))) as HTMLDialogElement; }
const text = (m: { root: Element }) => m.root.textContent || "";
// Domain attributes identify records regardless of whether a redesign uses rows or cards.

it("offers device identity, source filters, search and deletion in neutral SSR", async () => {
  const c = await connected([record("a", "a.kfx")]); await c.manager.restore(saved(c.device));
  const root = document.createElement("div"); root.innerHTML = server.markup("books", c.input);
  const bar = byAttribute(root, "data-kindle-device-bar");
  expect(byRole(bar, "heading", "设备")).toBeDefined();
  expect(byLabel(bar, "切换设备")).toBeDefined();
  expect(byRole(bar, "link", "打开设备排版预览")).toBeDefined();
  expect(byRole(bar, "status")).toBeDefined();
  expect(bar.textContent).not.toContain("我的 Paperwhite");

  expect(byRole(root, "button", "批量选择")).toBeDefined();
  const filters = byRole(root, "group", "按来源筛选");
  expect(filters.getAttribute("role")).toBe("group"); expect(filters.getAttribute("aria-label")).toBe("按来源筛选");
  expect(elements(filters, "button").map(node => [node.textContent, node.getAttribute("aria-pressed")]))
    .toEqual([["全部", "true"], ["来自 Bindery", "false"], ["其他", "false"]]);
  expect(byLabel(root, "搜索设备上的书")).toBeDefined();
  expect(allByRole(root, "button").some(node => node.textContent?.startsWith("删除所选"))).toBe(false);
  expect(byRole(root, "region", "设备书籍").textContent).not.toContain("从书库传书");
  expect(elements(root, "table")).toHaveLength(0);
  expect(byRole(root, "region", "设备书籍列表")).toBeDefined();
  expect(allByAttribute(root, "data-device-book")).toHaveLength(0);
  expect(root.textContent).toContain("连接并授权设备后，可查看和管理设备上的书籍。");
});

it("renders the transfer filters, compact search, setting fields and ordered queue without a redundant heading in SSR", () => {
  const root = document.createElement("div"); root.innerHTML = server.markup("transfer", input());
  expect(byRole(root, "heading", "设置")).toBeDefined(); expect(byRole(root, "heading", "队列")).toBeDefined();
  const filters = byRole(root, "group", "筛选");
  expect(filters.getAttribute("role")).toBe("group"); expect(filters.getAttribute("aria-label")).toBe("筛选");
  expect(elements(filters, "button").map(node => [node.textContent, node.getAttribute("aria-pressed")]))
    .toEqual([["不在设备", "true"], ["未读", "false"], ["全部", "false"]]);
  expect(byLabel(root, "搜索书库")).toBeDefined();
  expect(allByAttribute(root, "data-transfer-book")).toHaveLength(2);
  const aside = byRole(root, "complementary", "传输");
  const footer = elements(root, "div").find(node => node.getAttribute("class") === "device-send-footer")!;
  expect(footer.parentElement?.getAttribute("class")).toBe("dialog-actions");
  expect(footer.parentElement?.parentElement?.tagName.toLowerCase()).toBe("dialog");
  expect(allByAttribute(aside, "data-transfer-target")).toHaveLength(0);
  expect(byAttribute(footer, "data-transfer-target").textContent).toContain("尚未连接设备");
  expect(byLabel(footer, "排版方案")).toBeDefined();
  const queue = byRole(aside, "region", "传输队列");
  expect(allByAttribute(queue, "data-queue-item")).toHaveLength(0);
  expect(byRole(root, "dialog", /^发送/)).toBeDefined();
  const startButton = button(footer, "发送");
  expect(startButton.hasAttribute("disabled")).toBe(true);
  expect(allByAttribute(footer, "data-start-hint")).toHaveLength(1);
  expect(elements(queue, "button")).toHaveLength(0);
  expect(byRole(root, "button", "选择 书库甲")).toBeDefined();
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
  const rows = allByAttribute(root, "data-queue-item"), bars = elements(root, "progress");
  // Finished, failed and waiting rows carry no bar; only running transfers do.
  expect(rows).toHaveLength(5); expect(bars).toHaveLength(4); expect(elements(rows[0], "progress")).toHaveLength(0);
  expect(bars[0].getAttribute("value")).toBe(String(15 * mb)); expect(bars[0].getAttribute("max")).toBe(String(90 * mb));
  expect(bars[0].getAttribute("aria-valuetext")).toBe("已写入 15.0 / 90.0 MB · 4.8 MB/s · 剩余约 16 秒");
  expect(bars[1].hasAttribute("value")).toBe(false); expect(bars[1].getAttribute("aria-valuetext")).toContain("估计");
  expect(bars[2].getAttribute("value")).toBe(String(2 * mb)); expect(bars[2].getAttribute("max")).toBe(String(5 * mb));
  expect(bars[2].getAttribute("aria-valuetext")).toBe("已下载 2.0 / 5.0 MB · 1.0 MB/s · 剩余约 3 秒");
  expect(bars[3].hasAttribute("value")).toBe(false); expect(bars[3].getAttribute("aria-valuetext")).toContain("总大小未知");
  expect(rows.every(row => !row.textContent!.includes("KPW3"))).toBe(true);
  expect(byText(root, /^共 5 本/).textContent).toBe("共 5 本 · 已完成 1 · 已写入 45.0 / 120.0 MB（另 3 本待转换）");
  const live = allByAttribute(root, "aria-live"), announcements = live.map(node => node.textContent), liveChildren = live.map(node => Array.from(node.childNodes));
  expect(live).toHaveLength(5); expect(live.every(node => node.getAttribute("aria-live") === "polite" && node.getAttribute("aria-atomic") === "true")).toBe(true);
  expect(elements(root, "p").every(node => !node.hasAttribute("role"))).toBe(true);
  const next = initial.map(value => value.id === "write" ? { ...value, loaded: 20 * mb, writtenBytes: 20 * mb, etaSeconds: 14 } : value.id === "convert" ? { ...value, message: "正在转换 KFX · 已用 1.3 秒 · 预计剩余约 1 秒（估计）" } : value);
  mounted.update(next);
  expect(allByAttribute(root, "data-queue-item")).toEqual(rows); expect(elements(root, "progress")).toEqual(bars);
  expect(allByAttribute(root, "aria-live")).toEqual(live); expect(live.map(node => node.textContent)).toEqual(announcements);
  expect(live.map(node => Array.from(node.childNodes))).toEqual(liveChildren);
  expect(bars[0].getAttribute("value")).toBe(String(20 * mb));
  expect(byText(root, /^共 5 本/).textContent).toContain("已写入 50.0 / 120.0 MB");
  mounted.update(next.map(value => value.id === "write" ? { ...value, phase: "finalize", message: "正在完成写入", loaded: value.total } : value));
  expect(bars[0].hasAttribute("value")).toBe(false); expect(bars[0].getAttribute("aria-valuetext")).toBe("正在完成写入");
  expect(live[1].textContent).toBe("书籍 write：正在完成写入");
  mounted.update(next.map(value => value.id === "write" ? { ...value, state: "失败", message: "Kindle 已断开，请重新插入后重试", writtenBytes: 0 } : value));
  expect(live[1].textContent).toContain("失败：Kindle 已断开"); expect(elements(rows[1], "progress")).toHaveLength(0);
  expect(rows[1]!.textContent).toContain("Kindle 已断开，请重新插入后重试");
  expect(byText(root, /^共 5 本/).textContent).toContain("失败 1"); expect(byText(root, /^共 5 本/).textContent).toContain("已写入 30.0 / 120.0 MB");
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
    converter: { convert }, profile: async () => defaultProfile(), thumbnail: async () => new Uint8Array(),
  }));
  const m = mount("transfer", { ...c.input, queue }); await settle(m);
  const id = queue.enqueue(c.device, "a".repeat(32));
  try {
    await settle(m);
    expect(queue.snapshot()[0]).toMatchObject({ phase: "download", loaded: undefined, total: undefined });
    expect(byText(m.root, "正在读取书库 EPUB")).toBeDefined();
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
    // One book: its row already shows the bytes, so the summary stays a count.
    expect(byAttribute(m.root, "data-queue-summary").textContent).toBe("共 1 本 · 已完成 0");
  } finally { deliver(response); queue.cancel(id); await settle(m); }
  expect(convert).not.toHaveBeenCalled();
});

it("renders the connection title, three numbered steps and remembered devices in SSR", () => {
  const root = document.createElement("div"); root.innerHTML = server.markup("connect", input());
  const connection = byRole(root, "region", "连接设备"), steps = byRole(connection, "list");
  expect(byRole(connection, "heading", "把 Kindle 或 Kobo 用 USB 接上。")).toBeDefined();
  expect(allByRole(steps, "listitem")).toHaveLength(3);
  // The Kindle model choice appears only after an unpaired Kindle root is picked.
  expect(elements(steps, "input").filter(node => node.getAttribute("type") === "radio")).toHaveLength(0);
  const picker = button(connection, "选择设备目录"); expect(picker.hasAttribute("disabled")).toBe(true);
  expect(byRole(byRole(root, "complementary", "记住的设备"), "heading", "记住的设备")).toBeDefined();
  // Shown inline on /devices itself, so it must not link back to /devices.
  expect(allByRole(connection, "link").filter(link => link.getAttribute("href") === "/devices")).toHaveLength(0);
});

it.each(["books", "connect", "transfer"] as const)("hydrates neutral SSR for %s, restores the device, then updates after unplug/replug", async page => {
  const c = await connected([record("a", "a.kfx")]);
  // Even a populated client manager must not change the first render.
  await c.manager.restore(saved(c.device));
  const html = server.markup(page, c.input);
  expect(html).toContain("检测中…"); expect(html).not.toContain("我的 Paperwhite");
  const m = mount(page, c.input), ssrBar = byAttribute(m.root, "data-kindle-device-bar");
  await settle(m); expect(text(m)).toContain("我的 Paperwhite");
  expect(text(m)).toContain("Kindle Paperwhite 3"); expect(text(m)).toContain("固件 5.16.2.1.1");
  expect(byAttribute(m.root, "data-kindle-device-bar")).toBe(ssrBar);
  if (page === "books") expect(allByAttribute(m.root, "data-device-book")).toHaveLength(1);
  if (page === "transfer") expect(allByAttribute(m.root, "data-transfer-book").map(b => b.getAttribute("data-transfer-book"))).toEqual(["b"]);
  if (page === "connect") expect(allByAttribute(m.root, "data-remembered-device")).toHaveLength(1);
  c.fs.unplug(); await c.manager.probe(); await settle(m); expect(text(m)).toContain("已断开"); expect(text(m)).not.toContain("已枚举文件");
  if (page === "books") expect(allByAttribute(m.root, "data-device-book")).toHaveLength(0);
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
  fire(button(m.root, "选择设备目录"), "click"); await settle(m); expect(text(m)).toContain("完成首次配对"); expect(text(m)).toContain("配对、传书与字体管理会写入相应目录");
  const models = byRole(m.root, "group", "型号");
  expect(elements(models, "button").map(node => node.textContent)).toEqual(["Kindle Paperwhite 3", "Kindle Oasis 3", "其他 Kindle"]);
  fire(button(models, "Kindle Oasis 3"), "click"); m.flush();
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

it("labels books sent with the built-in profile by its current name, not the one recorded at transfer", async () => {
  const c = await connected([{ ...record("a", "a.kfx"), profile_name: "默认（只用书籍自带样式）" }]);
  const m = mount("books", c.input); await settle(m);
  expect(text(m)).not.toContain("默认（只用书籍自带样式）");
  expect(elements(m.root, "table")).toHaveLength(0);
});

it("filters device books using library metadata and filename fallback, including the empty state", async () => {
  const c = await connected([record("a", "a.kfx", "wide")]); await c.fs.write("documents/陌生的书.azw3", "other");
  const m = mount("books", c.input); await settle(m); expect(text(m)).toContain("书库甲"); expect(text(m)).toContain("陌生的书"); expect(text(m)).not.toContain("宽边距");
  fire(button(m.root, "其他"), "click"); m.flush(); expect(allByAttribute(m.root, "data-device-book").map(n => n.getAttribute("data-device-book"))).toEqual(["陌生的书.azw3"]);
  fire(button(m.root, "全部"), "click"); m.flush(); const search = field(m.root, "搜索设备上的书"); search.value = "作者"; fire(search, "input"); m.flush(); expect(allByAttribute(m.root, "data-device-book")).toHaveLength(1);
  search.value = "不存在"; fire(search, "input"); m.flush(); expect(allByAttribute(m.root, "data-device-book")).toHaveLength(0); expect(text(m)).toContain("没有符合条件的书籍");
});

it("confirms selected deletion, removes the matching sidecar/record/thumbnail, and refreshes usage", async () => {
  const r = record("a", "a.kfx"); r.thumbnail = "thumbnail_id_a_EBOK_portrait.jpg";
  const c = await connected([r]); await c.fs.write("documents/a.sdr/reading-position", "position"); await c.fs.write(`system/thumbnails/${r.thumbnail}`, "jpeg"); await c.fs.write("documents/other.txt", "other");
  const m = mount("books", c.input); await settle(m); selectBook(m, "选择 书库甲");
  fire(button(m.root, "删除所选（1）"), "click"); m.flush(); expect(text(m)).toContain(".sdr 文件夹"); expect(text(m)).toContain("此操作无法撤销");
  expect(deleteDialog(m.root).open).toBe(true); fire(button(m.root, "确认删除"), "click"); await settle(m);
  await expect(c.fs.bytes("documents/a.kfx")).rejects.toMatchObject({ name: "NotFoundError" }); await expect(c.fs.bytes("documents/a.sdr/reading-position")).rejects.toMatchObject({ name: "NotFoundError" }); await expect(c.fs.bytes(`system/thumbnails/${r.thumbnail}`)).rejects.toMatchObject({ name: "NotFoundError" });
  expect(JSON.parse(await c.fs.text(".bindery/manifest.json")).books).toEqual([]); expect(allByAttribute(m.root, "data-device-book").map(n => n.getAttribute("data-device-book"))).toEqual(["other.txt"]); expect(m.context().inventory()!.usage.books).toBe(5);
});

it("clears old inventory and selection when switching devices and prevents deletion against the new device", async () => {
  const a = await connected([record("a", "a.kfx")]), b = await connected([record("b", "a.kfx")]);
  const m = mount("books", a.input); await settle(m); selectBook(m, "选择 书库甲"); fire(button(m.root, "删除所选（1）"), "click"); m.flush();
  await a.manager.restore(saved(b.device)); await settle(m); expect(deleteDialog(m.root).open).toBe(false); expect(button(m.root, "删除所选（0）")).toBeDefined();
  expect(text(m)).toContain("书库乙"); expect(await b.fs.text("documents/a.kfx")).toBe("BOOK");
});

it("matches a foreign-id device record by fingerprint across the books and transfer pages", async () => {
  const foreign = "b".repeat(32), libraryId = "a".repeat(32), title = "三章书", libraryTitle = "三章书！", { data, positions } = await miniKfx();
  const fingerprint = await bookFingerprint(title, null), chapter = positions.chapters[1]!, eid = [...chapter.eids][0]!;
  const c = await connected([{ ...record(foreign, `${title}.kfx`, "wide"), fingerprint: fingerprint ?? undefined, size: data.length }]);
  await c.fs.write(`documents/${title}.kfx`, data);
  await c.fs.write(`documents/${title}.sdr/position.yjf`, lprStore(positionString(eid, 0, chapter.startPid), 1_792_748_847_039n));
  c.input.books = [{ ...book(libraryId, libraryTitle), author: null }]; c.input.chapters = vi.fn(async () => ({ [libraryId]: "第一章" }));
  const transfer = vi.fn(async () => { throw new Error("测试队列尚未接入转换服务"); }); c.input.queue = new TransferQueue({ transferBook: transfer });
  const m = mount("books", c.input); await settle(m);
  expect(text(m)).toContain(libraryTitle);
  expect(byAttribute(m.root, "data-device-progress").textContent).toContain("读到：第一章");
  expect(button(m.root, `预览 ${libraryTitle}`)).toBeDefined();
  const resend = button(m.root, `重新传入 ${libraryTitle}`); expect(resend.hasAttribute("disabled")).toBe(false);
  fire(resend, "click"); await settle(m);
  expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ identity: c.device.identity }), libraryId, "wide", expect.objectContaining({ overwrite: true }));
  m.page("transfer"); await settle(m); fire(button(m.root, "全部"), "click"); m.flush();
  expect(text(m)).toContain("已在设备");
});

it("enqueues a retransmission with the recorded profile and overwrite enabled", async () => {
  const c = await connected([record("a", "a.kfx", "wide")]); const transfer = vi.fn(async () => { throw new Error("profile was removed"); }); c.input.queue = new TransferQueue({ transferBook: transfer });
  const m = mount("books", c.input); await settle(m);
  const row = byAttribute(m.root, "data-device-book", "a.kfx");
  fire(elements(row, "button").find(node => node.getAttribute("aria-haspopup") === "menu")!, "click"); m.flush();
  expect(byRole(row, "menuitem", "预览 书库甲")).toBeDefined();
  expect(byRole(row, "menuitem", "重新传入 书库甲")).toBeDefined();
  expect(byRole(row, "menuitem", "从设备删除 书库甲")).toBeDefined();
  fire(button(m.root, "重新传入 书库甲"), "click"); await settle(m); expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ identity: c.device.identity }), "a", "wide", expect.objectContaining({ overwrite: true }));
  expect(text(m)).toContain("已加入传输队列：书库甲");
});

it("retransmits a tweaked Kindle book with its recorded settings snapshot", async () => {
  const settings = { ...EMPTY_SETTINGS, lineHeight: 1.8 };
  const c = await connected([{ ...record("a", "a.kfx"), profile_name: "默认（已调整）", settings }]);
  const transfer = vi.fn(async () => { throw new Error("conversion stop"); }); c.input.queue = new TransferQueue({ transferBook: transfer });
  const m = mount("books", c.input); await settle(m);
  expect(text(m)).not.toContain("默认（已调整）");
  fire(button(m.root, "重新传入 书库甲"), "click"); await settle(m);
  expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ identity: c.device.identity }), "a", "default", expect.objectContaining({ overwrite: true, settings }));
});

it("retransmits a Kobo book with its recorded settings snapshot and keeps old records on the default path", async () => {
  const id = "c".repeat(32), filename = "Bindery/书库甲.kepub.epub", settings = { ...EMPTY_SETTINGS, stripPageMargins: true };
  const c = await connectedKobo([filename]); c.input.books = [book(id, "书库甲")];
  await c.fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: [{ book_id: id, filename, transferred_at: new Date().toISOString(), settings }] }));
  const transfer = vi.fn(async () => { throw new Error("conversion stop"); }); c.input.queue = new TransferQueue({ transferBook: transfer });
  const m = mount("books", c.input); await settle(m);
  fire(button(m.root, "重新传入 书库甲"), "click"); await settle(m);
  expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ identity: c.device.identity }), id, "default", expect.objectContaining({ overwrite: true, settings }));

  const old = await connectedKobo([filename]); old.input.books = [book(id, "书库甲")];
  await old.fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: [{ book_id: id, filename, transferred_at: new Date().toISOString() }] }));
  const oldTransfer = vi.fn(async () => { throw new Error("conversion stop"); }); old.input.queue = new TransferQueue({ transferBook: oldTransfer });
  const oldView = mount("books", old.input); await settle(oldView);
  fire(button(oldView.root, "重新传入 书库甲"), "click"); await settle(oldView);
  expect(oldTransfer).toHaveBeenCalledWith(expect.objectContaining({ identity: old.device.identity }), id, "default", expect.objectContaining({ overwrite: true }));
});

it("loads device profiles, applies library filters/search and preserves selection across paging", async () => {
  const c = await connected([record("a", "a.kfx")]); c.input.books = [book("a", "书库甲"), book("b", "书库乙", true), ...Array.from({ length: 26 }, (_, i) => book(`x${i}`, `未读 ${i}`))];
  c.input.loadProfiles = vi.fn(async () => [defaultProfile(), { ...defaultProfile(), id: "wide", name: "宽边距", builtIn: false }]);
  const m = mount("transfer", c.input); await settle(m); expect(c.input.loadProfiles).toHaveBeenCalledWith(); expect(elements(m.root, "option").map(n => n.textContent)).toContain("宽边距");
  expect(allByAttribute(m.root, "data-transfer-book")).toHaveLength(24); expect(text(m)).not.toContain("已在设备");
  await c.manager.probe(); await settle(m); expect(c.input.loadProfiles).toHaveBeenCalledOnce();
  selectBook(m, "选择 书库乙"); fire(button(m.root, "下一页"), "click"); m.flush(); expect(text(m)).toContain("已选 1 本");
  expect(byAttribute(m.root, "data-transfer-selection").textContent).not.toContain("已选");
  await c.manager.probe(); await settle(m); expect(text(m)).toContain("已选 1 本");
  fire(button(m.root, "未读"), "click"); m.flush(); expect(allByAttribute(m.root, "data-transfer-book").map(n => n.getAttribute("data-transfer-book"))).not.toContain("b"); expect(text(m)).toContain("已在设备");
  const search = field(m.root, "搜索书库"); search.value = "书库甲"; fire(search, "input"); m.flush(); expect(allByAttribute(m.root, "data-transfer-book")).toHaveLength(1); expect(text(m)).toContain("估计大小：待转换后确定");
});

it("starts at the connected device's remembered profile and remembers a change", async () => {
  const c = await connected([record("a", "a.kfx")]);
  c.input.loadProfiles = vi.fn(async () => [defaultProfile(), { ...defaultProfile(), id: "wide", name: "宽边距", builtIn: false }]);
  const save = vi.fn(async () => ({}));
  c.input.reading = { get: vi.fn(async () => ({ margin: "narrow", profileId: "wide" })), save };
  const m = mount("transfer", c.input); await settle(m);
  expect(c.input.reading.get).toHaveBeenCalledWith(c.device.identity.id, "kindle");
  const select = () => byLabel(m.root, "排版方案") as HTMLSelectElement;
  expect(select().value).toBe("wide");
  select().value = "default"; fire(select(), "change"); await settle(m);
  expect(save).toHaveBeenCalledWith(c.device.identity.id, "kindle", { margin: "narrow", profileId: "default" });
});

it("keeps the queue running while moving among Kindle pages, supports cancel and clear, and renders notices", async () => {
  const c = await connected(); let reject!: (e: Error) => void;
  const transfer = vi.fn((_device: PairedDevice, _book: string, _profile: string, options: TransferOptions = {}) => new Promise<ManifestBook>((_resolve, r) => { reject = r; options.signal?.addEventListener("abort", () => r(new DOMException("cancel", "AbortError"))); options.progress?.({ state: "转换", phase: "convert", message: "正在转换 KFX", startedAt: Date.now(), phaseStartedAt: Date.now() }); }));
  c.input.queue = new TransferQueue({ transferBook: transfer });
  const m = mount("transfer", c.input); await settle(m); selectBook(m, "选择 书库甲"); fire(button(m.root, "发送 1 本"), "click"); await settle(m);
  expect(text(m)).toContain("正在转换 KFX"); expect(transfer).toHaveBeenCalledOnce(); const context = m.context(); m.page("books"); await settle(m); m.page("connect"); await settle(m); m.page("transfer"); await settle(m);
  expect(m.context()).toBe(context); expect(transfer).toHaveBeenCalledOnce(); expect(text(m)).toContain("正在转换 KFX");
  fire(button(m.root, "取消 书库甲"), "click"); await settle(m); expect(text(m)).toContain("失败"); expect(text(m)).toContain("操作已取消");
  fire(button(m.root, "清除已结束"), "click"); m.flush(); expect(allByAttribute(m.root, "data-queue-item")).toHaveLength(0);
  expect(text(m)).toContain("GPL-3.0-or-later"); expect(text(m)).toContain("GNU GENERAL PUBLIC LICENSE"); expect(elements(m.root, "a").some(a => a.getAttribute("href") === "https://crates.io/api/v1/crates/boko/0.5.0/download")).toBe(true);
  reject(new Error("already cancelled"));
});

it("starts with the books sent from the library selected, under 全部, once the device is ready", async () => {
  const c = await connected([record("a", "a.kfx")]); c.input.preselected = ["a", "missing"];
  const m = mount("transfer", c.input); await settle(m);
  expect(button(m.root, "全部").getAttribute("aria-pressed")).toBe("true");
  expect(allByAttribute(m.root, "data-transfer-book").filter(row => byRole(row, "button").getAttribute("aria-pressed") === "true").map(row => row.getAttribute("data-transfer-book"))).toEqual(["a"]);
  expect(button(m.root, "发送 1 本").hasAttribute("disabled")).toBe(false);
});

it("uses the selected profile and overwrite setting, shows failure, and retries profile loading", async () => {
  const c = await connected([record("a", "a.kfx")]); const transfer = vi.fn(async () => { throw new Error("Kindle 空间不足"); }); c.input.queue = new TransferQueue({ transferBook: transfer });
  let fail = true; c.input.loadProfiles = async () => { if (fail) throw new Error("配置服务暂时不可用"); const profile = defaultProfile(); return [{ ...profile, id: "wide", name: "宽边距", builtIn: false, settings: { ...profile.settings, stripFonts: true, stripImages: true, stripLineHeight: true, stripParagraphSpacing: true } }]; };
  const m = mount("transfer", c.input); await settle(m); expect(text(m)).toContain("配置服务暂时不可用"); fail = false; fire(button(m.root, "重试"), "click"); await settle(m);
  fire(button(m.root, "全部"), "click"); m.flush(); const select = byLabel(m.root, "排版方案") as HTMLSelectElement; select.value = "wide"; fire(select, "change"); m.flush(); fire(button(m.root, "覆盖设备上的同名书"), "click"); m.flush();
  expect(byAttribute(m.root, "data-profile-summary").textContent).toBe("去掉书籍自带字体 · 去掉所有图片（保留封面） · 去掉书籍自带行高 · 去掉书籍自带段间距");
  selectBook(m, "选择 书库甲"); expect(text(m)).toContain("约 4 B（按设备已有副本）"); fire(button(m.root, "发送 1 本"), "click"); await settle(m);
  expect(transfer).toHaveBeenCalledWith(expect.anything(), "a", "wide", expect.objectContaining({ overwrite: true })); expect(text(m)).toContain("Kindle 空间不足");
  // Retry re-queues the same book with the same profile and options, replacing the failed row.
  fire(button(m.root, "重试 书库甲"), "click"); await settle(m);
  expect(transfer).toHaveBeenCalledTimes(2); expect(transfer).toHaveBeenLastCalledWith(expect.anything(), "a", "wide", expect.objectContaining({ overwrite: true }));
  expect(allByAttribute(m.root, "data-queue-item")).toHaveLength(1);
});

it("refreshes inventory after queue completion and exposes accurate enumerated usage", async () => {
  const c = await connected(); const transfer = vi.fn(async () => { const r = record("a", "a.kfx"); await c.fs.write("documents/a.kfx", "BOOK"); await c.fs.write(".bindery/manifest.json", JSON.stringify({ version: 1, books: [r] })); return r; }); c.input.queue = new TransferQueue({ transferBook: transfer });
  const m = mount("transfer", c.input); await settle(m); selectBook(m, "选择 书库甲"); fire(button(m.root, "发送 1 本"), "click"); await settle(m);
  expect(text(m)).toContain("已传入 Kindle"); expect(m.context().inventory()!.usage.books).toBe(4); expect(m.context().inventory()!.usage.capacity).toBeNull(); expect(allByAttribute(m.root, "data-transfer-book").map(n => n.getAttribute("data-transfer-book"))).toEqual(["b"]);
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
  const details = byAttribute(m.root, "data-unreadable-notice");
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
  const report = byAttribute(m.root, "data-delete-report");
  expect(report.textContent).toContain("书籍文件已删除"); expect(report.textContent).toContain("documents/a.sdr/blocked"); expect(report.textContent).not.toContain("documents/a.sdr/after");
  expect(report.textContent).toContain("设备本机"); expect(report.textContent).toContain("支持长路径的工具"); expect(report.textContent).toContain("NotFoundError");
  expect(m.context().state().status).toBe("granted"); expect(text(m)).toContain("已删除 1 本设备书籍"); expect(deleteDialog(m.root).open).toBe(false);
  expect(JSON.parse(await c.fs.text(".bindery/manifest.json")).books).toEqual([]);
  for (const path of ["documents/a.kfx", "documents/a.sdr/after", `system/thumbnails/${r.thumbnail}`]) await expect(c.fs.bytes(path)).rejects.toMatchObject({ name: "NotFoundError" });
});

it("retries only remaining books after a partially successful bulk deletion", async () => {
  const c = await connected([record("a", "a.kfx"), record("b", "b.kfx")]);
  const m = mount("books", c.input); await settle(m);
  selectBook(m, "全选当前筛选书籍");
  fire(button(m.root, "删除所选（2）"), "click"); m.flush();
  let fail = true;
  c.fs.beforeOperation = op => { if (fail && op.operation === "remove" && op.path === "/documents/b.kfx") { fail = false; throw new Error("删除暂时失败，请重试"); } };
  fire(button(m.root, "确认删除"), "click"); await settle(m);
  expect(text(m)).toContain("删除暂时失败，请重试"); expect(m.context().inventory()!.books.map(b => b.filename)).toEqual(["b.kfx"]);
  expect(deleteDialog(m.root).textContent).toContain("所选 1 本书");
  fire(button(m.root, "确认删除"), "click"); await settle(m);
  expect(m.context().inventory()!.books).toEqual([]); expect(deleteDialog(m.root).open).toBe(false);
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
  expect(text(m)).not.toContain("去掉书籍自带字体"); expect(text(m)).not.toContain("去掉所有图片（保留封面）");
  expect(text(m)).toContain("排版方案"); expect(text(m)).not.toContain("boko"); expect(text(m)).not.toContain("GPL-3.0");
  expect(text(m)).not.toContain("documents/"); expect(text(m)).not.toContain(".sdr"); expect(text(m)).not.toContain("KFX");
  expect(allByAttribute(m.root, "data-transfer-book")).toHaveLength(2);
  expect(elements(m.root, "option").some(node => node.textContent === "默认")).toBe(true);
});

it("auto-syncs Kobo reading once per connection and again after re-detection", async () => {
  const c = await connectedKobo(), sync = vi.fn(async (_device: PairedDevice): Promise<SyncResult> => ({ synced: 5, skipped: 0, marked_read: 1, unchanged: 0, kept: 0, lagged: false, unmatched: 0 }));
  c.input.syncKobo = sync;
  const m = mount("books", c.input); await settle(m);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(text(m)).toContain("已同步 5 本书的阅读进度 · 1 本标为已读");
  fire(button(m.root, "重新检测"), "click"); await settle(m);
  expect(sync).toHaveBeenCalledTimes(2);
});

it("auto-syncs Kindle reading once per connection and again after re-detection", async () => {
  const c = await connected([record("a", "a.kfx", "content_a")]);
  const sync = vi.fn(async (_device: PairedDevice): Promise<SyncResult> => ({ synced: 2, skipped: 1, marked_read: 0, unchanged: 0, kept: 1, lagged: false, unmatched: 0 }));
  c.input.syncKindle = sync;
  const m = mount("books", c.input); await settle(m);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(text(m)).toContain("已同步 2 本书的阅读进度 · 1 本无法读取 · 1 本设备进度较旧，已保留之前的记录");
  fire(button(m.root, "重新检测"), "click"); await settle(m);
  expect(sync).toHaveBeenCalledTimes(2);
});

it("shows Kindle reading progress and never calls a full position finished", async () => {
  const c = await connected([record("a", "a.kfx", "content_a")]), { data, positions } = await miniKfx();
  await c.fs.write("documents/a.kfx", data);
  const last = positions.chapters.at(-1)!, location = positionString([...last.eids][0]!, 0, positions.totalPid - 1);
  await c.fs.write("documents/a.sdr/a673205bd7b6c0394b1593a9fbced79ec.yjf", lprStore(location, 1_792_748_847_039n));
  c.input.chapters = vi.fn(async () => ({ a: "第三章 全景敞视主义" }));
  const m = mount("books", c.input); await settle(m);
  const cells = allByAttribute(m.root, "data-device-progress"), progress = cells.map(node => node.textContent);
  expect(progress).toHaveLength(1);
  expect(progress[0]).toMatch(/^在读 \d+% · /);
  expect(progress[0]).not.toContain("已读完");
  // The synced chapter is click-reachable in the book menu, not hover-only.
  expect(c.input.chapters).toHaveBeenCalledWith(c.device.identity.id);
  expect(cells[0]!.textContent).toContain("读到：第三章 全景敞视主义");
  expect(byRole(m.root, "progressbar")).toBeDefined();
});

it("marks Kobo library sources and only allows deleting Bindery-managed KEPUBs", async () => {
  const c = await connectedKobo(["Bindery/书库甲.kepub.epub", "Other/外部.epub"]); const m = mount("books", c.input); await settle(m);
  expect(allByAttribute(m.root, "data-device-book").map(n => n.getAttribute("data-device-book"))).toEqual(["Bindery/书库甲.kepub.epub", "Other/外部.epub"]);
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
  expect(text(m)).toContain("只读取阅读进度，不会修改 KoboReader.sqlite"); expect(text(m)).not.toContain("不会读写 KoboReader.sqlite");
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
  const select = elements(m.root, "select").find(node => node.getAttribute("aria-label") === "切换设备")!;
  expect(elements(select, "option").map(node => node.textContent)).toEqual([
    "Kindle A · 已连接",
    "Kobo B · 已连接",
    "连接新设备…",
  ]);
  (select as HTMLSelectElement).value = b.identity.id; fire(select, "change"); await settle(m);
  expect(m.context().state().device?.identity.id).toBe(b.identity.id);
  expect(preference.get()).toBe(b.identity.id);
  expect((select as HTMLSelectElement).value).toBe(b.identity.id);

  const next = mount("books", input(new KindleDeviceManager(repo, undefined, preference))); await settle(next);
  expect(next.context().state().device?.identity.id).toBe(b.identity.id);
});
