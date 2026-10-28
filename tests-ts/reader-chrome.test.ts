import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import solid from "vite-plugin-solid";
import { solidOptions } from "../scripts/solid-options";
import { clientDocument, elements, fire } from "./support/client-dom";

type Probe = typeof import("./fixtures/reader/chrome");
let ui: Probe, ssr: Probe, mounted: ReturnType<Probe["mount"]> | undefined;
let root: HTMLElement, storage: Map<string, string>, scrolled: Element[], phone = false;
let browserDocument: Document;
const directory = mkdtempSync(join(tmpdir(), "bindery-reader-chrome-"));
const windowListeners = new Map<string, Set<EventListener>>(), documentListeners = new Map<string, Set<EventListener>>();
const listen = (map: Map<string, Set<EventListener>>, type: string, handler: EventListener) => { if (!map.has(type)) map.set(type, new Set()); map.get(type)!.add(handler); };
const dispatch = (map: Map<string, Set<EventListener>>, type: string, event: object) => map.get(type)?.forEach(handler => handler(event as Event));
let animations = new Map<number, FrameRequestCallback>(), nextAnimation = 0;
function animate() { const queue = animations; animations = new Map(); for (const callback of queue.values()) callback(0); mounted?.flush(); }
const all = (node: Element, tag = "*") => elements(node, tag);
const named = (tag: string, label: string, node: Element = root) => all(node, tag).find(el => el.getAttribute("aria-label") === label || all(node, "label").some(text => text.getAttribute("for") === el.getAttribute("id") && text.textContent === label)) as HTMLElement;
const button = (label: string, node: Element = root) => all(node, "button").find(el => el.getAttribute("aria-label") === label || el.textContent === label) as HTMLButtonElement;
const dialog = (name: string) => all(root, "dialog").find(el => all(el, "h2")[0]?.textContent === name) as HTMLDialogElement;
const status = () => all(root).filter(el => el.getAttribute("role") === "status").map(el => el.textContent).join(" ");
function click(label: string) { const target = button(label); target.focus(); fire(target, "click"); mounted!.flush(); animate(); }
function key(name: string, target: Element = root) {
  const preventDefault = vi.fn();
  dispatch(windowListeners, "keydown", { key: name, target, preventDefault }); mounted!.flush(); return preventDefault;
}
function browserGlobals() {
  // Solid caches templates; preserve their ownerDocument between tests.
  const document = browserDocument ||= clientDocument(); document.documentElement.textContent = "";
  const prototype = Object.getPrototypeOf(document.createElement("div"));
  prototype.contains = function (target: Node) { for (let node: Node | null = target; node; node = node.parentNode) if (node === this) return true; return false; };
  prototype.focus = function () { Object.defineProperty(document, "activeElement", { configurable: true, value: this }); };
  Object.defineProperty(document, "activeElement", { configurable: true, value: null });
  prototype.scrollIntoView = function () { scrolled.push(this); };
  const matches = (node: Element, selector: string) => {
    const match = /^(\w+|\*)?(?:\[([^=\]]+)(?:=([^\]]+))?\])?$/.exec(selector.trim());
    return !!match && (!match[1] || match[1] === "*" || node.localName === match[1]) && (!match[2] || node.hasAttribute(match[2]) && (!match[3] || node.getAttribute(match[2]) === match[3]));
  };
  prototype.closest = function (selectors: string) {
    for (let node: Element | null = this; node; node = node.parentNode?.nodeType === 1 ? node.parentNode as Element : null) if (selectors.split(",").some(selector => matches(node!, selector))) return node;
    return null;
  };
  prototype.querySelectorAll = function (selector: string) { return all(this).filter(el => selector.split(",").some(item => matches(el, item))); };
  prototype.querySelector = function (selector: string) { return this.querySelectorAll(selector)[0] || null; };
  for (const name of ["open", "hidden", "disabled", "inert"]) Object.defineProperty(prototype, name, {
    configurable: true, get(this: Element) { return this.hasAttribute(name); },
    set(this: Element, value: boolean) { if (value) this.setAttribute(name, ""); else this.removeAttribute(name); },
  });
  prototype.show = prototype.showModal;
  prototype.getBoundingClientRect = () => ({ left: 100, right: 480, top: 76, bottom: 800 });
  const styles = new WeakMap<Element, object>();
  Object.defineProperty(prototype, "style", { configurable: true, get(this: Element) {
    if (!styles.has(this)) styles.set(this, { setProperty(name: string, value: string) { (this as Record<string, unknown>)[name] = value; }, removeProperty(name: string) { delete (this as Record<string, unknown>)[name]; } });
    return styles.get(this);
  } });
  document.addEventListener = (type: string, handler: EventListenerOrEventListenerObject) => listen(documentListeners, type, handler as EventListener);
  document.removeEventListener = (type: string, handler: EventListenerOrEventListenerObject) => { documentListeners.get(type)?.delete(handler as EventListener); };
  const location = new URL(`/book/${"d".repeat(32)}/preview/0`, "http://bindery.local");
  const history = { state: null, pushState: vi.fn((_data, _unused, path) => { location.href = new URL(path, location).href; }), replaceState: vi.fn((_data, _unused, path) => { location.href = new URL(path, location).href; }) };
  storage = new Map(); scrolled = [];
  vi.stubGlobal("document", document); vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", { location, innerWidth: 1440, innerHeight: 900, matchMedia: () => ({ get matches() { return phone; }, addEventListener() {}, removeEventListener() {} }), addEventListener: (type: string, listener: EventListener) => listen(windowListeners, type, listener), removeEventListener: (type: string, listener: EventListener) => windowListeners.get(type)?.delete(listener) });
  vi.stubGlobal("history", history);
  vi.stubGlobal("localStorage", { getItem: (name: string) => storage.get(name) || null, setItem: (name: string, value: string) => storage.set(name, value) });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { animations.set(++nextAnimation, callback); return nextAnimation; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => animations.delete(id));
}
beforeAll(async () => {
  browserGlobals();
  const entry = resolve("tests-ts/fixtures/reader/chrome.tsx");
  for (const server of [true, false]) {
    const result = await build({
      configFile: false, logLevel: "silent",
      plugins: [{ name: "reader-chrome-boundaries", enforce: "pre", resolveId(source, importer) {
        if (!importer?.endsWith("/features/reader/reader.tsx")) return;
        if (source === "./frame") return resolve("tests-ts/fixtures/reader/chrome-frame.ts");
        if (source === "./progress") return resolve("tests-ts/fixtures/reader/chrome-progress.ts");
      } }, solid({ ...solidOptions, dev: false, hot: false })],
      resolve: { conditions: server ? ["node", "production"] : ["browser", "production"] },
      define: { "process.env.NODE_ENV": '"production"' }, ssr: { noExternal: true },
      build: { write: false, minify: true, ...(server ? { ssr: entry } : { lib: { entry, formats: ["es"] } }) },
    });
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing reader hydration bundle");
    expect(chunk.imports).toEqual([]);
    const filename = join(directory, server ? "ssr.mjs" : "client.mjs"); writeFileSync(filename, chunk.code);
    const module: Probe = await import(/* @vite-ignore */ pathToFileURL(filename).href);
    if (server) ssr = module; else ui = module;
  }
});
beforeEach(() => { phone = false; browserGlobals(); });
afterEach(() => { mounted?.dispose(); mounted = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); windowListeners.clear(); documentListeners.clear(); animations.clear(); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });
function mount() {
  root = document.createElement("div"); root.innerHTML = ssr.markup(); document.documentElement.appendChild(root);
  vi.stubGlobal("_$HY", { r: {}, completed: new WeakSet(), events: [] });
  const article = all(root, "article")[0];
  mounted = ui.mount(root); mounted.flush(); animate();
  expect(all(root, "article")).toEqual([article]);
}

it("hydrates isolated frames, chapter/global position and boundary controls", () => {
  mount();
  expect(status()).toContain("1 / 3 跨页 · 0%");
  expect(all(root, "iframe")).toHaveLength(3);
  expect(button("上一页").disabled).toBe(true); expect(button("下一页").disabled).toBe(false);
  ui.frames.publish({ section: 1, page: 2, pageCount: 4, frame: 1 }); mounted!.flush();
  expect(status()).toContain("2 / 4 跨页 · 67%");
  expect(all(named("nav", "章节目录"), "a").map(el => el.getAttribute("aria-current"))).toEqual([null, "page"]);
  expect(all(root, "iframe").map(el => el.getAttribute("aria-hidden"))).toEqual(["true", "false", "true"]);
  expect(ui.writer.positions.at(-1)).toEqual({ section: 1, page: 2, count: 4 });
  ui.frames.publish({ section: 1, page: 4, pageCount: 4, frame: 1 }); mounted!.flush();
  expect(button("下一页").disabled).toBe(true); expect(button("上一页").disabled).toBe(false);
});

it("opens one modal TOC/search sheet, focuses current chapter, traps focus and restores it", () => {
  mount(); click("目录与检索");
  const drawer = dialog("目录与检索"), links = all(named("nav", "章节目录"), "a");
  expect(drawer.open).toBe(true); expect(drawer.getAttribute("aria-modal")).toBe("true");
  expect(drawer.textContent).toContain("书名<&>"); expect(drawer.textContent).toContain("作者 · 读到 0%");
  expect(button("目录与检索").getAttribute("aria-expanded")).toBe("true");
  expect(button("上一页").hidden).toBe(true);
  expect(scrolled).toEqual([links[0]]); expect(document.activeElement).toBe(links[0]);
  expect(button("关闭目录与检索")).toBeTruthy();
  button("目录").focus();
  const preventDefault = vi.fn(); fire(drawer, "keydown", { key: "Tab", shiftKey: true, preventDefault });
  expect(preventDefault).toHaveBeenCalled(); expect(document.activeElement).toBe(links.at(-1));
  click("检索"); expect(dialog("目录与检索")).toBe(drawer); expect(button("检索").getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(named("input", "在全书中检索"));
  expect(named("nav", "章节目录").hidden).toBe(true);
  click("目录"); expect(links[0].getAttribute("aria-current")).toBe("page"); expect(links[0].textContent).toContain("正在读");
  fire(drawer, "keydown", { key: "Escape" }); mounted!.flush();
  expect(drawer.open).toBe(false); expect(document.activeElement).toBe(button("目录与检索"));
  click("目录与检索"); fire(drawer, "click", { clientX: 1, clientY: 1 }); mounted!.flush(); expect(drawer.open).toBe(false);
  click("目录与检索"); fire(links[1], "click"); mounted!.flush(); animate();
  expect(ui.frames.opens.at(-1)).toMatchObject({ section: 1, page: 1, find: "" }); expect(drawer.open).toBe(false);
  expect(document.activeElement).toBe(all(root, "iframe")[1]);
});

it("keeps Aa nonmodal, closes by toggle, outside pointer and Escape, with focus return", () => {
  mount(); click("阅读设置");
  const settings = dialog("排版");
  expect(settings.open).toBe(true); expect(settings.hasAttribute("aria-modal")).toBe(false);
  const preventDefault = vi.fn(); fire(settings, "keydown", { key: "Tab", preventDefault }); expect(preventDefault).not.toHaveBeenCalled();
  key("Escape"); expect(settings.open).toBe(false); expect(document.activeElement).toBe(button("阅读设置"));
  click("阅读设置"); click("阅读设置"); expect(settings.open).toBe(false);
  click("阅读设置"); dispatch(documentListeners, "pointerdown", { target: button("衬线") }); mounted!.flush(); expect(settings.open).toBe(true);
  dispatch(documentListeners, "pointerdown", { target: root }); mounted!.flush(); expect(settings.open).toBe(false);
  click("阅读设置"); click("目录与检索"); expect(settings.open).toBe(false); expect(dialog("目录与检索").open).toBe(true);
});

it("persists font cards, stepper, sliders, alignment and paper without a chrome brightness mode", () => {
  mount(); click("阅读设置");
  expect(ui.frames.configurations.at(-1)).toMatchObject({ fontSize: 21, lineHeight: 2.1, styleMode: "custom" });
  click("纯白"); expect(button("纯白").getAttribute("aria-pressed")).toBe("true");
  click("暗色"); click("无衬线"); click("左对齐"); click("增大字号");
  for (const [label, value] of [["行高", 1.65], ["左右边距", 12], ["上下边距", 30]] as const) {
    const input = named("input", label) as HTMLInputElement; input.valueAsNumber = value; fire(input, "input"); mounted!.flush();
  }
  expect(ui.frames.configurations.at(-1)).toMatchObject({ readerBg: "paper", brightnessMode: "dim", fontFamily: "sans", fontSize: 22, lineHeight: 1.65, textAlignMode: "left", pagePaddingX: 12, pagePaddingY: 30 });
  expect(JSON.parse(storage.get("bindery:reader")!)).toEqual(ui.frames.configurations.at(-1));
  expect(all(root, "article")[0].hasAttribute("data-brightness")).toBe(false);
  for (let index = 0; index < 40; index++) click("增大字号");
  expect(button("增大字号").disabled).toBe(true); expect(ui.frames.configurations.at(-1)?.fontSize).toBe(28);
  for (let index = 0; index < 40; index++) click("减小字号");
  expect(button("减小字号").disabled).toBe(true); expect(ui.frames.configurations.at(-1)?.fontSize).toBe(12);
  click("书籍原样"); expect(button("无衬线").disabled).toBe(true); expect((named("input", "行高") as HTMLInputElement).disabled).toBe(true);
  expect(button("书籍原样").getAttribute("aria-pressed")).toBe("true");
  click("自定义"); expect(button("无衬线").getAttribute("aria-pressed")).toBe("true");
});

it("loads legacy settings unchanged and announces a transient progress failure", () => {
  storage.set("bindery:reader", JSON.stringify({ styleMode: "custom", readerBg: "mint", brightnessMode: "dim", fontSize: 26, fontFamily: "kai", textAlignMode: "right" }));
  mount(); expect(ui.frames.configurations.at(-1)).toMatchObject({ fontSize: 26, brightnessMode: "dim", readerBg: "mint", fontFamily: "kai", textAlignMode: "right" });
  vi.useFakeTimers(); ui.writer.report("阅读进度保存失败，将在下次翻页时重试"); mounted!.flush();
  expect(status()).toContain("阅读进度保存失败"); expect(status()).toContain("1 / 3 跨页 · 0%");
  vi.advanceTimersByTime(2600); mounted!.flush(); expect(status()).not.toContain("阅读进度保存失败");
});

it("searches, highlights and appends results, navigates with find, and cancels cleared searches", async () => {
  mount(); click("目录与检索"); click("检索");
  const search = named("section", "全文检索"), input = named("input", "在全书中检索") as HTMLInputElement, form = named("form", "全文检索");
  const fetch = vi.fn().mockResolvedValue(Response.json({ query: "词", indexed_sections: 2, hits: [{ index: 1, title: "词一", snippet: "原词<&>", offset: 0 }], has_more: true, next_offset: 1 }));
  vi.stubGlobal("fetch", fetch);
  input.value = "词"; fire(input, "input"); mounted!.flush(); fire(form, "submit");
  await new Promise(resolve => setTimeout(resolve, 0)); mounted!.flush();
  expect(status()).toContain("找到1处，已索引 2 节");
  expect(all(search, "mark").map(el => el.textContent)).toEqual(["词"]);
  expect(all(search, "a")[0].getAttribute("href")).toContain("find=%E8%AF%8D");
  fetch.mockResolvedValue(Response.json({ query: "词", indexed_sections: 2, hits: [{ index: 1, title: "词二", snippet: "第二词", offset: 1 }], has_more: false }));
  click("再显示 20 处"); await new Promise(resolve => setTimeout(resolve, 0)); mounted!.flush();
  expect(fetch.mock.calls[1][0]).toContain("offset=1"); expect(all(search, "a")).toHaveLength(2);
  fire(all(search, "a")[0], "click"); mounted!.flush(); animate();
  expect(ui.frames.opens.at(-1)).toMatchObject({ section: 1, page: 1, find: "词" }); expect(dialog("目录与检索").open).toBe(false);
  expect(history.replaceState).toHaveBeenCalledWith(null, "", expect.stringContaining("/preview/1?return_to=")); expect(history.pushState).not.toHaveBeenCalled();
  click("目录与检索"); click("检索");
  let complete!: (response: Response) => void;
  fetch.mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
  fire(form, "submit"); mounted!.flush(); const signal = fetch.mock.calls.at(-1)![1].signal as AbortSignal;
  click("清空"); expect(signal.aborted).toBe(true); expect(input.value).toBe("");
  complete(Response.json({ query: "词", indexed_sections: 2, hits: [{ index: 1, title: "过期词", snippet: "词", offset: 0 }] }));
  await new Promise(resolve => setTimeout(resolve, 0)); mounted!.flush();
  expect(all(search, "li")).toHaveLength(0); expect(document.activeElement).toBe(input); expect(button("开始检索").disabled).toBe(true);
});

it("uses phone defaults and bottom sheets, toggles bars without changing frames, and seeks on scrub commit", () => {
  phone = true; mount();
  expect(ui.frames.configurations.at(-1)).toMatchObject({ fontSize: 19, lineHeight: 2, pagePaddingX: 24 });
  const frames = all(root, "iframe");
  expect(button("显示工具栏").getAttribute("aria-expanded")).toBe("false");
  ui.frames.interaction!("tap"); ui.frames.interaction!("toggle"); mounted!.flush(); expect(button("隐藏工具栏").getAttribute("aria-expanded")).toBe("true");
  ui.frames.interaction!("tap"); ui.frames.interaction!("toggle"); mounted!.flush(); expect(button("显示工具栏").getAttribute("aria-expanded")).toBe("false");
  expect(all(root, "iframe")).toEqual(frames); expect(ui.frames.turns).toEqual([]);
  click("显示工具栏"); click("阅读设置"); expect(dialog("排版").getAttribute("data-presentation")).toBe("bottom-sheet"); expect(dialog("排版").hasAttribute("aria-modal")).toBe(false);
  ui.frames.interaction!("activity"); mounted!.flush(); expect(dialog("排版").open).toBe(true);
  expect(ui.frames.interaction!("tap")).toBe(false); mounted!.flush(); expect(dialog("排版").open).toBe(false);
  click("目录与检索"); expect(dialog("目录与检索").getAttribute("data-presentation")).toBe("bottom-sheet"); click("关闭目录与检索");
  click("下一章"); expect(ui.frames.opens.at(-1)?.section).toBe(1);
  const input = named("input", "全书进度（按章节估算）") as HTMLInputElement;
  input.valueAsNumber = 75; fire(input, "input"); mounted!.flush();
  const before = ui.frames.opens.length;
  // client-dom does not bubble events; deliver the commit to its actual owner.
  fire(input.parentNode!.parentNode!.parentNode as Element, "change"); mounted!.flush();
  expect(ui.frames.opens).toHaveLength(before + 1);
  expect(ui.frames.opens.at(-1)).toMatchObject({ section: 1, fraction: .5 });
});

it("fades desktop chrome when idle and restores it on iframe activity without hiding focused controls", () => {
  vi.useFakeTimers(); mount();
  vi.advanceTimersByTime(3500); mounted!.flush(); expect(button("显示工具栏").getAttribute("aria-expanded")).toBe("false");
  ui.frames.interaction!("activity"); mounted!.flush(); expect(button("隐藏工具栏").getAttribute("aria-expanded")).toBe("true");
  button("阅读设置").focus(); vi.advanceTimersByTime(3500); mounted!.flush(); expect(button("隐藏工具栏").getAttribute("aria-expanded")).toBe("true");
});

it("forwards page controls and shortcuts, blocks them while a panel is open, and cleans up", () => {
  mount(); click("下一页"); expect(ui.frames.turns).toEqual([1]);
  key("Backspace"); expect(ui.frames.turns).toEqual([1, -1]); key("PageDown"); expect(ui.frames.keys).toEqual(["PageDown"]);
  key("Backspace", all(root, "input")[0]); expect(ui.frames.turns).toEqual([1, -1]);
  click("阅读设置"); key("PageDown"); key("Backspace"); expect(ui.frames.keys).toEqual(["PageDown"]);
  mounted!.dispose(); mounted = undefined;
  expect(ui.frames.destroyed).toBe(true); expect(ui.writer.destroyed).toBe(true);
  expect([...windowListeners.values()].every(set => set.size === 0)).toBe(true); expect([...documentListeners.values()].every(set => set.size === 0)).toBe(true);
});
