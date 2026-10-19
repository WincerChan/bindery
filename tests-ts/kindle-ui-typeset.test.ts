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
import { clientDocument, elements, fire } from "./support/client-dom";
import { fakeKindle } from "./support/fake-fs";

type Props = { manager: KindleDeviceManager | null; data: PreviewData; profiles: ProfileApi; chapters: (book: string) => Promise<{ title: string; item_path: string }[]>; initialFont?: string; onDirty?: (dirty: boolean) => void; onPreview?: (font: string) => unknown };
type Bundle = { flush: () => void; markup: (kind: string, props: Props) => string; mount: (root: HTMLElement, kind: string, props: Props) => { dispose: () => void; flush: () => void } };
let ui: Bundle, ssr: Bundle;
const directory = mkdtempSync(join(tmpdir(), "bindery-typeset-ui-")), disposers: (() => void)[] = [];
class Handles implements HandleRepository {
  devices = new Map<string, RememberedDevice>();
  async list() { return [...this.devices.values()]; }
  async put(device: RememberedDevice) { this.devices.set(device.id, device); }
  async remove(id: string) { this.devices.delete(id); }
}
// Valid SFNT header without a name table exercises the core's filename fallback.
const font = (name: string) => new File([new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], name);
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
    import { render, hydrate, renderToString } from "@solidjs/web";
    import { Loading, flush } from "solid-js";
    import { TypesetPage } from ${JSON.stringify(resolve("src/features/kindle/typeset/preview-page.tsx"))};
    import { FontsPage } from ${JSON.stringify(resolve("src/features/kindle/typeset/fonts-page.tsx"))};
    function view(kind, props) { return kind === "fonts" ? <FontsPage manager={props.manager} onPreview={props.onPreview} /> : <TypesetPage {...props} />; }
    export function markup(kind, props) { return renderToString(() => <Loading>{view(kind, props)}</Loading>); }
    export function mount(root, kind, props) { return { dispose: hydrate(() => <Loading>{view(kind, props)}</Loading>, root), flush }; }
    export { flush };
  `);
  for (const server of [false, true]) {
    const result = await build({ configFile: false, logLevel: "silent", plugins: [solid(solidOptions)],
      resolve: { dedupe: ["solid-js", "@solidjs/web"], conditions: server ? ["node", "production"] : ["browser", "production"] },
      define: { "process.env.NODE_ENV": JSON.stringify("production") }, ssr: { noExternal: true },
      build: { write: false, minify: true, ...(server ? { ssr: entry } : { lib: { entry, formats: ["es" as const] } }) },
    });
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(chunk => chunk.type === "chunk" && chunk.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing page probe");
    expect(chunk.imports).toEqual([]);
    const path = join(directory, server ? "server.mjs" : "client.mjs"); writeFileSync(path, chunk.code);
    const module = await import(/* @vite-ignore */ pathToFileURL(path).href) as Bundle;
    if (server) ssr = module; else ui = module;
  }
});
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); vi.unstubAllGlobals(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.flush(); } };
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
const button = (root: Element, text: string) => elements(root, "button").find(element => element.textContent === text)!;
function setValue(node: Element, value: string, type = "input") { (node as HTMLInputElement).value = value; fire(node, type); ui.flush(); }
const input = (root: Element, id: string) => elements(root, "input").find(element => element.id === id)!;
const labels = (root: Element, tag: string, label: string) => elements(root, "label").find(element => element.firstChild?.textContent === label)!.getElementsByTagName(tag)[0]!;

it("hydrates neutral fonts markup, scans after mount, clears after unplug and reuses the handle after replug", async () => {
  const { fs, manager } = await paired(["Book-Regular.ttf", "Book-Light.otf", "Book-Bold.ttf"]);
  await fs.write("fonts/._Book.ttf", "ignore"); await fs.write("fonts/Readme.txt", "keep");
  const mounted = mount("fonts", manager); await settle();
  expect(elements(mounted.root, "tr", "data-font-family")).toHaveLength(1);
  expect(mounted.root.textContent).toContain("Light"); expect(mounted.root.textContent).toContain("手动安装");
  const sample = elements(mounted.root, "iframe")[0]!; expect(sample.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(elements(mounted.root, "a").find(a => a.textContent === "用它预览")!.getAttribute("href")).toBe("/kindle/preview?font=Book");
  fs.unplug(); await manager.probe(); await settle(); expect(elements(mounted.root, "tr", "data-font-family")).toHaveLength(0);
  expect(mounted.root.textContent).toContain("请连接并授权");
  fs.plug(); await manager.probe(); await settle(); expect(elements(mounted.root, "tr", "data-font-family")).toHaveLength(1);
});

it("navigates the preview action within the SPA while retaining a real font-specific link", async () => {
  const { manager } = await paired(["Book-Regular.ttf"]), onPreview = vi.fn();
  const mounted = mount("fonts", manager, { onPreview }); await settle();
  const link = elements(mounted.root, "a").find(anchor => anchor.textContent === "用它预览")!;
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
  fire(button(mounted.root, "正文"), "click"); ui.flush(); setValue(input(mounted.root, "kt-marginX"), "2.5");
  expect((labels(mounted.root, "textarea", "生成的 CSS（只读）") as HTMLTextAreaElement).value).toContain("margin-left: 2.5em");
  fs.unplug(); await manager.probe(); await settle();
  expect(mounted.root.textContent).toContain("可选择记住的设备离线编辑");
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("2.5");
});

it("takes over a chapter already loaded before hydration and applies CSS and device fonts only inside its frame", async () => {
  const { manager, fs } = await paired(["Book-Regular.ttf"]), doc = clientDocument();
  const head = doc.createElement("head"), body = doc.createElement("body"), fonts = new Set<FontFace>(), appFonts = new Set<FontFace>();
  doc.documentElement.appendChild(head); doc.documentElement.appendChild(body);
  Object.assign(head, { append: (...nodes: Node[]) => nodes.forEach(node => head.appendChild(node)) });
  Object.defineProperties(doc, { head: { value: head }, body: { value: body }, fonts: { value: fonts }, readyState: { value: "complete" }, contentType: { value: "text/html" }, URL: { value: "http://bindery.local/book/a/epub/Text/%E7%AC%AC%E4%B8%80%20%E7%AB%A0.xhtml" } });
  Object.assign(doc, { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  Object.defineProperty(document, "fonts", { value: appFonts });
  const bookStyle = doc.createElement("style"); bookStyle.textContent = "p { color: black; }"; head.appendChild(bookStyle);
  vi.stubGlobal("FontFace", class { load() { return Promise.resolve(this); } });
  const mounted = mount("preview", manager, {}, root => { Object.defineProperty(elements(root, "iframe")[0]!, "contentDocument", { value: doc }); }); await settle();
  expect(elements(head, "style", "data-bindery-profile")).toHaveLength(1);
  fire(button(mounted.root, "正文"), "click"); ui.flush();
  setValue(labels(mounted.root, "select", "字体（设备上已安装）"), "Book", "change"); await settle();
  expect(elements(head, "style", "data-bindery-profile")[0]!.textContent).toContain('font-family: "Book"');
  expect(bookStyle.textContent).toBe("p { color: black; }"); expect(fonts.size).toBe(1); expect(appFonts.size).toBe(0);
  // Invalid CSS retains the last stylesheet; loss of device access still removes its FontFaces.
  setValue(labels(mounted.root, "textarea", "额外自定义 CSS"), "p {"); fs.unplug(); await manager.probe(); await settle(); expect(fonts.size).toBe(0);
  mounted.dispose(); expect(elements(head, "style", "data-bindery-profile")).toHaveLength(0); expect(bookStyle.parentNode).toBe(head);
});

it("keeps the built-in profile immutable, saves a copy, then updates and deletes only that device's custom profile", async () => {
  const { manager, id } = await paired(), profiles = api(), mounted = mount("preview", manager, { profiles }); await settle();
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).disabled).toBe(true);
  expect((button(mounted.root, "删除") as HTMLButtonElement).disabled).toBe(true);
  fire(button(mounted.root, "另存为"), "click"); ui.flush();
  setValue(labels(mounted.root, "input", "新方案名称"), "大字正文");
  fire(elements(mounted.root, "form")[0]!, "submit"); await settle();
  expect(profiles.create).toHaveBeenCalledWith({ deviceId: id, name: "大字正文", settings: EMPTY_SETTINGS });
  setValue(input(mounted.root, "kt-textIndent"), "2"); fire(button(mounted.root, "保存"), "click"); await settle();
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
  fire(button(mounted.root, "正文"), "click"); ui.flush(); setValue(input(mounted.root, "kt-marginX"), "3");
  vi.mocked(window.confirm).mockReturnValue(false); fire(button(mounted.root, "默认 · 书籍自带样式"), "click"); ui.flush();
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("3");
  fire(button(mounted.root, "重置"), "click"); ui.flush(); expect(mounted.root.textContent).toContain("有未保存的修改");
  vi.mocked(window.confirm).mockReturnValue(true); fire(button(mounted.root, "重置"), "click"); ui.flush();
  expect((input(mounted.root, "kt-marginX") as HTMLInputElement).value).toBe("1");
  setValue(labels(mounted.root, "textarea", "额外自定义 CSS"), "p {");
  expect(mounted.root.textContent).toContain("CSS 花括号不匹配"); expect((button(mounted.root, "保存") as HTMLButtonElement).disabled).toBe(true);
  setValue(labels(mounted.root, "textarea", "额外自定义 CSS"), "p { color: black; }");
  vi.mocked(profiles.update).mockRejectedValueOnce(new Error("数据库暂不可用")); fire(button(mounted.root, "保存"), "click"); await settle();
  expect(mounted.root.textContent).toContain("数据库暂不可用"); expect(mounted.root.textContent).toContain("有未保存的修改"); expect(onDirty).toHaveBeenLastCalledWith(true);
});

it("holds a dirty draft on its original device during an external device change", async () => {
  const first = await paired(), second = await paired(), profiles = api();
  const mounted = mount("preview", first.manager, { profiles }); await settle();
  fire(button(mounted.root, "正文"), "click"); ui.flush(); setValue(input(mounted.root, "kt-marginX"), "4");
  await first.repo.put((await second.manager.remembered())[0]!); await first.manager.restore(second.id); await settle();
  expect(mounted.root.textContent).toContain("保存仍属于");
  fire(button(mounted.root, "保存"), "click"); await settle();
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
  expect((button(mounted.root, "保存") as HTMLButtonElement).disabled).toBe(true);
  setValue(labels(mounted.root, "select", "字体（设备上已安装）"), "", "change");
  expect(mounted.root.textContent).not.toContain("无效的字体名称");
});

it("offers device-less model preview and protects against stale chapter responses", async () => {
  let finish!: (value: { title: string; item_path: string }[]) => void;
  const chapters = vi.fn((id: string) => id === "b" ? new Promise<{ title: string; item_path: string }[]>(resolve => { finish = resolve; }) : Promise.resolve([{ title: "新第一章", item_path: "new.xhtml" }]));
  const mounted = mount("preview", null, { chapters }); await settle();
  setValue(labels(mounted.root, "select", "预览型号"), "KO3", "change");
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
  fire(button(row, "从设备删除"), "click"); ui.flush(); expect(await fs.bytes("fonts/Book-Regular.ttf")).toHaveLength(12);
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
