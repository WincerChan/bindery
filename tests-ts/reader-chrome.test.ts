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
let root: HTMLElement, storage: Map<string, string>, scrolled: Element[];
const directory = mkdtempSync(join(tmpdir(), "bindery-reader-chrome-"));
const windowListeners = new Map<string, EventListener>(), documentListeners = new Map<string, EventListener>();
let animations = new Map<number, FrameRequestCallback>(), nextAnimation = 0;
function animate() { const queue = animations; animations = new Map(); for (const callback of queue.values()) callback(0); mounted?.flush(); }
const all = (node: Element, tag = "*") => elements(node, tag);
const css = (name: string) => all(root).find(el => el.className.split(/\s+/).includes(name)) as HTMLElement;
const button = (label: string) => all(root, "button").find(el => el.getAttribute("aria-label") === label || el.textContent === label) as HTMLButtonElement;
function click(label: string) { fire(button(label), "click"); mounted!.flush(); animate(); }
function key(name: string, target: Element = root, shiftKey = false) {
  const preventDefault = vi.fn();
  windowListeners.get("keydown")!({ key: name, target, shiftKey, preventDefault } as unknown as KeyboardEvent);
  mounted!.flush(); return preventDefault;
}
function browserGlobals() {
  const document = clientDocument();
  const prototype = Object.getPrototypeOf(document.createElement("div"));
  prototype.contains = function (target: Node) { for (let node: Node | null = target; node; node = node.parentNode) if (node === this) return true; return false; };
  prototype.focus = function () { Object.defineProperty(document, "activeElement", { configurable: true, value: this }); };
  prototype.scrollIntoView = function () { scrolled.push(this); };
  prototype.closest = function (selectors: string) {
    for (let node: Element | null = this; node; node = node.parentNode?.nodeType === 1 ? node.parentNode as Element : null) {
      if (selectors.split(",").some(tag => tag.trim() === node!.localName)) return node;
    }
    return null;
  };
  prototype.querySelectorAll = function (selector: string) {
    return all(this).filter(el => selector.split(",").some(item => {
      const match = /^(\w+|\*)?(?:\[([^=\]]+)(?:=([^\]]+))?\])?$/.exec(item.trim());
      if (!match) throw new Error(`Unsupported reader selector: ${selector}`);
      return (!match[1] || match[1] === "*" || el.localName === match[1]) && (!match[2] || el.hasAttribute(match[2]) && (!match[3] || el.getAttribute(match[2]) === match[3]));
    }));
  };
  prototype.querySelector = function (selector: string) { return this.querySelectorAll(selector)[0] || null; };
  for (const name of ["open", "hidden", "disabled", "inert"]) Object.defineProperty(prototype, name, {
    configurable: true, get(this: Element) { return this.hasAttribute(name); },
    set(this: Element, value: boolean) { if (value) this.setAttribute(name, ""); else this.removeAttribute(name); },
  });
  document.addEventListener = (type: string, handler: EventListenerOrEventListenerObject) => { documentListeners.set(type, handler as EventListener); };
  document.removeEventListener = (type: string) => { documentListeners.delete(type); };
  const location = new URL(`/book/${"d".repeat(32)}/preview/0`, "http://bindery.local");
  const history = { state: null, pushState: vi.fn((_data, _unused, path) => { location.href = new URL(path, location).href; }), replaceState: vi.fn((_data, _unused, path) => { location.href = new URL(path, location).href; }) };
  storage = new Map(); scrolled = [];
  vi.stubGlobal("document", document); vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", { location, addEventListener: (type: string, listener: EventListener) => windowListeners.set(type, listener), removeEventListener: (type: string) => windowListeners.delete(type) });
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
beforeEach(() => { browserGlobals(); });
afterEach(() => { mounted?.dispose(); mounted = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); windowListeners.clear(); documentListeners.clear(); animations.clear(); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });
function mount() {
  root = document.createElement("div"); root.innerHTML = ssr.markup(); document.documentElement.appendChild(root);
  vi.stubGlobal("_$HY", { r: {}, completed: new WeakSet(), events: [] });
  const article = all(root, "article")[0];
  mounted = ui.mount(root); mounted.flush(); animate();
  expect(all(root, "article")).toEqual([article]);
}

it("hydrates the existing chrome and renders per-chapter status, clock and frame state", () => {
  mount();
  expect(css("reader-status").textContent).toMatch(/^1 \/ 3 · 33%\d{2}:\d{2}$/);
  expect(all(root, "iframe")).toHaveLength(3);
  expect(button("上一页").disabled).toBe(true); expect(button("下一页").disabled).toBe(false);
  ui.frames.publish({ section: 1, page: 2, pageCount: 4, frame: 1 }); mounted!.flush();
  expect(css("reader-heading").textContent).toBe("书名<&> · 第二节");
  expect(css("reader-status").textContent).toContain("2 / 4 · 50%");
  expect(css("reader-toc").textContent).toContain("共 2 节 · 当前 2");
  expect(all(css("reader-toc"), "a").map(el => el.getAttribute("aria-current"))).toEqual([null, "page"]);
  expect(all(root, "iframe").map(el => el.getAttribute("aria-hidden"))).toEqual(["true", "false", "true"]);
  expect(ui.writer.positions.at(-1)).toEqual({ section: 1, page: 2, count: 4 });
  ui.frames.publish({ section: 1, page: 4, pageCount: 4, frame: 1 }); mounted!.flush();
  expect(button("下一页").disabled).toBe(true); expect(button("上一页").disabled).toBe(false);
});

it("opens the TOC drawer, scrolls and focuses the current section, traps focus and closes", () => {
  mount(); click("切换目录");
  const drawer = css("reader-toc") as HTMLDialogElement, links = all(drawer, "a");
  expect(drawer.open).toBe(true); expect(button("切换目录").getAttribute("aria-expanded")).toBe("true");
  expect(button("上一页").hidden).toBe(true); expect(css("reader-column").inert).toBe(true);
  expect(scrolled).toEqual([links[0]]); expect(document.activeElement).toBe(links[0]);
  button("关闭目录").focus(); expect(key("Tab", button("关闭目录"), true)).toHaveBeenCalled(); expect(document.activeElement).toBe(links.at(-1));
  key("Escape"); expect(drawer.open).toBe(false); expect(document.activeElement).toBe(button("切换目录"));
  click("切换目录"); fire(css("reader-panel-backdrop"), "click"); mounted!.flush();
  expect(drawer.open).toBe(false); expect(document.activeElement).toBe(button("切换目录"));
  click("切换目录"); fire(links[1], "click"); mounted!.flush(); animate();
  expect(ui.frames.opens.at(-1)).toEqual({ section: 1, page: 1, find: "" }); expect(drawer.open).toBe(false);
  expect(document.activeElement).toBe(all(root, "iframe")[1]);
});

it("switches mutually exclusive popovers and closes by toggle, outside pointer, Escape and focus", () => {
  mount(); click("全文检索");
  const search = css("reader-search") as HTMLDialogElement, settings = css("reader-settings") as HTMLDialogElement;
  expect(search.open).toBe(true); expect(document.activeElement).toBe(all(search, "input")[0]);
  click("设置"); expect(search.open).toBe(false); expect(settings.open).toBe(true);
  expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
  key("Escape"); expect(settings.open).toBe(false); expect(document.activeElement).toBe(button("设置"));
  click("设置"); click("设置"); expect(settings.open).toBe(false);
  click("全文检索"); documentListeners.get("pointerdown")!({ target: root } as unknown as Event); mounted!.flush(); expect(search.open).toBe(false);
  click("全文检索"); documentListeners.get("pointerdown")!({ target: all(search, "input")[0] } as unknown as Event); mounted!.flush(); expect(search.open).toBe(true);
  documentListeners.get("focusin")!({ target: button("设置") } as unknown as Event); mounted!.flush(); expect(search.open).toBe(false);
});

it("persists background, brightness and every custom control with Python's steps and bounds", () => {
  mount(); click("设置"); expect(all(css("reader-settings"), "select")).toHaveLength(0);
  click("纸张"); click("暗色"); click("自定义");
  expect(all(root, "article")[0].getAttribute("data-background")).toBe("paper");
  expect(all(root, "article")[0].getAttribute("data-brightness")).toBe("dim");
  const selects = all(css("reader-settings"), "select") as HTMLSelectElement[];
  expect(all(selects[0], "option").map(el => el.getAttribute("value"))).toEqual(["serif", "sans", "mono"]);
  expect(all(selects[1], "option").map(el => el.getAttribute("value"))).toEqual(["1.55", "1.65", "1.75", "1.85", "1.95", "2.05"]);
  selects[0].value = "sans"; fire(selects[0], "change"); selects[1].value = "1.65"; fire(selects[1], "change"); selects[2].value = "left"; fire(selects[2], "change"); mounted!.flush();
  click("增大字号"); click("减小左右边距"); click("增大上下边距");
  expect(ui.frames.configurations.at(-1)).toMatchObject({ readerBg: "paper", brightnessMode: "dim", styleMode: "custom", fontFamily: "sans", fontSize: 18, lineHeight: 1.65, textAlignMode: "left", pagePaddingX: 7, pagePaddingY: 13 });
  expect(JSON.parse(storage.get("bindery:reader")!)).toEqual(ui.frames.configurations.at(-1));
  for (let index = 0; index < 40; index++) { click("增大字号"); click("增大左右边距"); click("减小上下边距"); }
  expect(ui.frames.configurations.at(-1)).toMatchObject({ fontSize: 27, pagePaddingX: 47, pagePaddingY: -1 });
  expect(button("增大字号").disabled).toBe(true); expect(button("增大左右边距").disabled).toBe(true); expect(button("减小上下边距").disabled).toBe(true);
});

it("loads stored settings after hydration and keeps a progress failure out of the page flow", () => {
  storage.set("bindery:reader", JSON.stringify({ styleMode: "custom", readerBg: "mint", brightnessMode: "dim", fontSize: 26 }));
  mount(); expect(all(root, "article")[0].getAttribute("data-background")).toBe("mint");
  expect(ui.frames.configurations.at(-1)).toMatchObject({ fontSize: 26, brightnessMode: "dim" });
  vi.useFakeTimers(); ui.writer.report("阅读进度保存失败，将在下次翻页时重试"); mounted!.flush();
  expect(css("reader-save-notice").textContent).toContain("阅读进度保存失败");
  expect(css("reader-status").textContent).toContain("1 / 3 · 33%");
  vi.advanceTimersByTime(2600); mounted!.flush(); expect(css("reader-save-notice")).toBeUndefined();
});

it("searches, highlights and appends results, navigates with find, and cancels cleared searches", async () => {
  mount(); click("全文检索");
  const input = all(css("reader-search"), "input")[0] as HTMLInputElement;
  const form = all(root, "form")[0];
  const fetch = vi.fn().mockResolvedValue(Response.json({ query: "词", indexed_sections: 2, hits: [{ index: 1, title: "词一", snippet: "原词<&>", offset: 0 }], has_more: true, next_offset: 1 }));
  vi.stubGlobal("fetch", fetch);
  input.value = "词"; fire(input, "input"); mounted!.flush(); fire(form, "submit");
  await new Promise(resolve => setTimeout(resolve, 0)); mounted!.flush();
  expect(css("reader-search-summary").textContent).toBe("已加载：1 · 已索引章节：2 · 可继续加载");
  expect(all(css("reader-search-results"), "mark").map(el => el.textContent)).toEqual(["词", "词"]);
  expect(all(css("reader-search-results"), "a")[0].getAttribute("href")).toContain("find=%E8%AF%8D");
  fetch.mockResolvedValue(Response.json({ query: "词", indexed_sections: 2, hits: [{ index: 1, title: "词二", snippet: "第二词", offset: 1 }], has_more: false }));
  click("加载更多"); await new Promise(resolve => setTimeout(resolve, 0)); mounted!.flush();
  expect(fetch.mock.calls[1][0]).toContain("offset=1"); expect(all(css("reader-search-results"), "li")).toHaveLength(2);
  fire(all(css("reader-search-results"), "a")[0], "click"); mounted!.flush(); animate();
  expect(ui.frames.opens.at(-1)).toEqual({ section: 1, page: 1, find: "词" });
  expect((css("reader-search") as HTMLDialogElement).open).toBe(false);
  expect(history.pushState).toHaveBeenCalledWith(null, "", expect.stringContaining("/preview/1?return_to="));
  click("全文检索");
  let complete!: (response: Response) => void;
  fetch.mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
  fire(form, "submit"); mounted!.flush(); const signal = fetch.mock.calls.at(-1)![1].signal as AbortSignal;
  click("清空"); expect(signal.aborted).toBe(true); expect(input.value).toBe("");
  complete(Response.json({ query: "词", indexed_sections: 2, hits: [{ index: 1, title: "过期词", snippet: "词", offset: 0 }] }));
  await new Promise(resolve => setTimeout(resolve, 0)); mounted!.flush();
  expect(all(css("reader-search-results"), "li")).toHaveLength(0);
  expect(document.activeElement).toBe(input); expect(button("检索").disabled).toBe(true);
});

it("forwards page controls and shortcuts, blocks them while a panel is open, and cleans up", () => {
  mount(); click("下一页"); expect(ui.frames.turns).toEqual([1]);
  key("Backspace"); expect(ui.frames.turns).toEqual([1, -1]);
  key("PageDown"); expect(ui.frames.keys).toEqual(["PageDown"]);
  key("Backspace", all(root, "input")[0]); expect(ui.frames.turns).toEqual([1, -1]);
  click("设置"); key("PageDown"); key("Backspace"); expect(ui.frames.keys).toEqual(["PageDown"]); expect(ui.frames.turns).toEqual([1, -1]);
  mounted!.dispose(); mounted = undefined;
  expect(ui.frames.destroyed).toBe(true); expect(ui.writer.destroyed).toBe(true); expect(windowListeners.size).toBe(0); expect(documentListeners.size).toBe(0);
});
