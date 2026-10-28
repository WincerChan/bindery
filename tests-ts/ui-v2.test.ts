import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { binderyIcons } from "../scripts/vite-icons";
import solid from "vite-plugin-solid";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { solidOptions } from "../scripts/solid-options";
import { clientDocument, elements, fire } from "./support/client-dom";
import { overlayPresentation } from "../src/ui/overlay-behavior";
import { allByRole, byAttribute, byName, byRole, parseHtml } from "./support/queries";

type Probe = typeof import("./fixtures/ui-v2");
let server: Probe, client: Probe, phone = false;
let mediaChange: (() => void) | undefined;
let browserDocument: Document;
const directory = mkdtempSync(join(tmpdir(), "bindery-ui-v2-")), disposers: (() => void)[] = [];
function browserGlobals() {
  // Solid caches DOM templates; keep their ownerDocument stable between tests.
  const document = browserDocument ||= clientDocument(), body = document.createElement("body");
  document.documentElement.textContent = "";
  document.documentElement.appendChild(body);
  Object.defineProperty(document, "body", { configurable: true, value: body });
  let active: Element | null = body;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  const prototype = Object.getPrototypeOf(body), styles = new WeakMap<Element, Record<string, unknown>>();
  Object.defineProperty(prototype, "style", { configurable: true, get(this: Element) {
    if (!styles.has(this)) styles.set(this, { setProperty(name: string, value: string) { this[name] = value; }, removeProperty(name: string) { delete this[name]; } });
    return styles.get(this);
  } });
  prototype.focus = function () { active = this; };
  prototype.show = prototype.showModal;
  prototype.getBoundingClientRect = () => ({ top: 100, left: 100, bottom: 144, right: 300 });
  document.addEventListener = vi.fn(); document.removeEventListener = vi.fn();
  vi.stubGlobal("document", document); vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900, addEventListener: vi.fn(), removeEventListener: vi.fn(), matchMedia: () => ({ get matches() { return phone; }, addEventListener: (_event: string, callback: () => void) => { mediaChange = callback; }, removeEventListener: vi.fn() }) });
}
beforeEach(() => { phone = false; mediaChange = undefined; browserGlobals(); });
beforeAll(async () => {
  browserGlobals();
  for (const ssr of [true, false]) {
    const entry = resolve("tests-ts/fixtures/ui-v2.tsx");
    const result = await build({ configFile: false, logLevel: "silent", plugins: [...binderyIcons(), solid({ ...solidOptions, dev: false, hot: false })],
      resolve: { conditions: ssr ? ["node", "production"] : ["browser", "production"] }, define: { "process.env.NODE_ENV": '"production"' }, ssr: { noExternal: true },
      build: { write: false, minify: true, ...(ssr ? { ssr: entry } : { lib: { entry, formats: ["es"] } }) } });
    const chunk = (Array.isArray(result) ? result : [result]).flatMap(output => "output" in output ? output.output : []).find(output => output.type === "chunk" && output.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing UI v2 probe");
    const path = join(directory, ssr ? "server.mjs" : "client.mjs"); writeFileSync(path, chunk.code);
    const module: Probe = await import(/* @vite-ignore */ pathToFileURL(path).href);
    if (ssr) server = module; else client = module;
  }
});
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); vi.unstubAllGlobals(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function mount(kind: Parameters<Probe["mount"]>[1]) {
  const root = document.createElement("div"); document.body.appendChild(root);
  const mounted = client.mount(root, kind); disposers.push(mounted.dispose);
  return { root, ...mounted };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("v2 render contracts", () => {
  it("renders named controls, native overlays and boolean states without native checkboxes", () => {
    const html = server.markup("controls");
    expect(html).toMatch(/<button[^>]*aria-label="设置"[^>]*title="设置"/);
    expect(html).toContain('role="switch"'); expect(html).toContain('aria-checked="true"');
    expect(html).toContain('role="group" aria-label="阅读状态"'); expect(html).toContain('aria-pressed="true"'); expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('type="range"'); expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('aria-label="已连接"'); expect(html).toContain('aria-label="减小字号"');
    expect(html).not.toContain('type="checkbox"'); expect(html).toContain("btn-count");
    expect(html).not.toMatch(/<button[^>]*\scount=/);
  });
  it("hugs the selected value with a labelled transparent native select overlay", () => {
    const html = server.markup("controls"), css = readFileSync("src/ui/ui.css", "utf8");
    expect(html).toMatch(/<label[^>]*class="ui-select-pill/); expect(html).toContain('class="ui-select-value" aria-hidden="true">全部');
    expect(html).toMatch(/<select[^>]*aria-label="排序"/);
    expect(css).toMatch(/\.ui-select-pill \{[^}]*width: max-content/);
    expect(css).toMatch(/\.ui-select-pill select \{[^}]*position: absolute; inset: 0;[^}]*opacity: 0/);
  });
  it("renders one token-driven intro shell for main, subpage, title-only, topbar, book and visual-size variants", () => {
    const html = server.markup("intros").replace(/<!--.*?-->/g, ""), css = readFileSync("src/ui/ui.css", "utf8"), tokens = readFileSync("src/styles.css", "utf8");
    expect(html).toContain('class="ui-page-intro ui-page-intro-subpage');
    expect(html).toContain('class="ui-page-intro-back"');
    expect(html).toContain('class="ui-page-intro-row"');
    expect(html).toContain('class="ui-page-intro-text"');
    expect(html).toContain('class="ui-page-intro-lead"');
    expect(html).toContain('class="ui-page-intro-cover-grid"');
    expect(html).toContain('class="ui-page-intro-cover-text"');
    expect(html).toContain('class="ui-page-intro-tail"');
    expect(html).toContain('class="ui-page-intro ui-page-intro-title-only"');
    expect(html).toContain('id="settings-intro-title"');
    const titleOnly = html.slice(html.indexOf("ui-page-intro-title-only"), html.indexOf("ui-page-intro-topbar"));
    expect(titleOnly).toContain("设置");
    expect(titleOnly).not.toContain("ui-page-eyebrow"); expect(titleOnly).not.toContain("ui-page-description"); expect(titleOnly).not.toContain("ui-page-actions"); expect(titleOnly).not.toContain("ui-page-visual");
    const topbar = html.slice(html.indexOf("ui-page-intro-topbar"), html.indexOf("ui-page-intro-book"));
    expect(topbar).toContain("排版预览"); expect(topbar).toContain("ui-page-intro-back"); expect(topbar).toContain("ui-page-actions");
    expect(topbar).not.toContain("ui-page-intro-row");
    expect(html).toContain("ui-page-intro-book");
    const book = html.slice(html.indexOf('id="book-intro"'), html.indexOf("ui-page-intro-visual-page"));
    expect(book).toContain('id="book-intro"'); expect(book).toContain("ui-page-intro-row"); expect(book).toContain("ui-page-visual"); expect(book).toContain("书库");
    for (const size of ["page", "reading", "vocabulary", "device"]) expect(html).toContain(`ui-page-intro-visual-${size}`);
    for (const value of ["--intro-pad-top: 40px", "--intro-stack-gap: 22px", "--intro-actions-offset: 6px", "--intro-title-line: 1.25", "--intro-eyebrow-size: var(--text-control)", "--intro-eyebrow-tracking: .08em", "--intro-lead-size: var(--text-body)", "--intro-lead-line: 1.85", "--intro-lead-max: 520px", "--intro-gap-next: var(--space-section)"]) expect(tokens).toContain(value);
    for (const value of ["--intro-pad-top: 0px", "--intro-stack-gap: 16px", "--intro-title-line: 1.3", "--intro-eyebrow-size: var(--text-meta)", "--intro-lead-line: 1.8"]) expect(tokens).toContain(value);
    expect(css).toMatch(/\.ui-page-intro \{[^}]*flex-direction: column;[^}]*padding-top: var\(--intro-pad-top\)/);
    expect(css).toMatch(/\.ui-page-intro-row \{[^}]*align-items: flex-start/);
    expect(css).toMatch(/\.ui-page-intro-lead \{(?![^}]*display: contents)[^}]*flex-direction: column;[^}]*gap: var\(--intro-stack-gap\)/);
    expect(css).toMatch(/\.ui-page-actions \{[^}]*margin-top: var\(--intro-actions-offset\)/);
    expect(css).toMatch(/\.ui-page-visual \{[^}]*align-self: center/);
  });
  it("renders exactly one heading in each board-backed variant, including the compact device masthead", () => {
    const html = server.markup("intros").replace(/<!--.*?-->/g, "");
    const headers = [...html.matchAll(/<header\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/header>/g)];
    expect(headers).toHaveLength(14);
    for (const [, name, content] of headers) expect(content!.match(/<h1\b/g), name).toHaveLength(1);
    for (const variant of ["guide", "split", "editor", "compact"]) expect(headers.some(h => h[1]!.includes(`ui-page-intro-${variant}`))).toBe(true);
    const book = headers.find(h => h[1]!.includes("ui-page-intro-book"))!;
    expect(book[1]).not.toContain("ui-page-intro-visual-cover");
    const compact = headers.find(h => h[1]!.includes("ui-page-intro-compact"))![2]!;
    expect(compact).toContain('class="sr-only">设备字体</h1>');
    expect(compact).toContain("我的 Paperwhite · 已连接");
  });
  it("composes introductory text, serif counted tabs, toolbar and labelled pagination", () => {
    const html = server.markup("pages").replace(/<!--.*?-->/g, "");
    expect(html).toContain('class="ui-page-visual"'); expect(html).toContain('aria-label="书库范围"');
    expect(html).toContain('class="ui-count is-accent">48'); expect(html).toContain('class="ui-toolbar-search"');
    expect(html).toContain('aria-label="分页"'); expect(html).toContain('aria-label="第 1 页，当前页">01');
    expect(html).toContain('aria-disabled="true" aria-label="上一页"'); expect(html).toContain('aria-label="下一页"');
    expect(html).toContain("page=2#books"); expect(html).toContain("/ 04 页"); expect(html).toContain("共 48 册");
  });
  it("renders accessible cover state decorations, compact titles and deterministic 13-color selection", () => {
    const html = server.markup("covers");
    for (const state of ["read", "failed", "generating", "not-in-library", "compact"]) expect(html).toContain(`cover-${state}`);
    expect(html).toContain('aria-label="浮生六记（已读）"'); expect(html).toContain('aria-label="重试生成《生成失败》"');
    expect(html).toContain('aria-valuenow="35"'); expect(html).toContain("cover-ribbon"); expect(html).toContain("cover-add");
    expect(new Set(Array.from({ length: 13 }, (_, index) => server.coverTone(index.toString(16)))).size).toBe(13);
    expect(server.coverTone("非十六进制书名")).toBe(server.coverTone("非十六进制书名"));
  });
  it("names a real cover image once, on the image itself", () => {
    const html = server.markup("covers"), real = html.slice(html.indexOf('src="/cover.jpg"') - 200, html.indexOf('src="/cover.jpg"') + 200);
    expect(real).toContain('alt="生成中（生成中）"'); expect(real).not.toContain('role="img"');
    expect(html.match(/role="img"/g)).toHaveLength(4); // the four drawn covers only
  });
  it("labels the existing native dialog system and distinguishes menu and nonmodal popover", () => {
    const html = server.markup("overlays");
    expect(html.match(/<dialog/g)).toHaveLength(4); expect(html.match(/aria-modal="true"/g)).toHaveLength(3);
    expect(html.match(/aria-labelledby=/g)).toHaveLength(4); expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"'); expect(html).toContain('role="menu"'); expect(html).toContain('role="menuitem"');
    expect(html.indexOf('role="menuitem" class="is-destructive"')).toBeGreaterThan(html.indexOf("<hr"));
    expect(html).not.toMatch(/<dialog[^>]*\sopen(?:\s|>)/);
  });
  it.each([false, true])("chooses desktop versus phone overlays (phone=%s)", phone => {
    expect(overlayPresentation("menu", phone)).toBe(phone ? "bottom-sheet" : "menu");
    expect(overlayPresentation("sheet", phone)).toBe(phone ? "bottom-sheet" : "sheet");
    expect(overlayPresentation("popover", phone)).toBe(phone ? "bottom-sheet" : "popover");
    expect(overlayPresentation("dialog", phone)).toBe(phone ? "page" : "dialog");
  });
});

describe("v2 client interaction", () => {
  it("updates segmented/select/switch/stepper state through actual component handlers", () => {
    const mounted = mount("controls"), buttons = elements(mounted.root, "button");
    fire(buttons.find(button => button.textContent === "已读")!, "click"); mounted.flush();
    expect(buttons.find(button => button.textContent === "已读")!.getAttribute("aria-pressed")).toBe("true");
    expect(elements(mounted.root, "span").find(span => span.className === "ui-select-value")!.textContent).toBe("已读");
    const select = elements(mounted.root, "select")[0] as HTMLSelectElement; select.value = "all"; fire(select, "change"); mounted.flush();
    expect(buttons.find(button => button.textContent === "全部")!.getAttribute("aria-pressed")).toBe("true");
    const toggle = buttons.find(button => button.getAttribute("role") === "switch")!; fire(toggle, "click"); mounted.flush(); expect(toggle.getAttribute("aria-checked")).toBe("false");
    fire(buttons.find(button => button.getAttribute("aria-label") === "增大字号")!, "click"); mounted.flush();
    expect(elements(mounted.root, "output").map(output => output.textContent)).toEqual(["22", "22"]);
  });
  it("updates the transparent range and disables steppers at their boundaries", () => {
    const mounted = mount("controls"), range = elements(mounted.root, "input").find(input => input.getAttribute("type") === "range") as HTMLInputElement;
    const buttons = elements(mounted.root, "button");
    for (const [value, label] of [[12, "减小字号"], [30, "增大字号"]] as const) {
      range.valueAsNumber = value; fire(range, "input"); mounted.flush();
      expect(elements(mounted.root, "output").map(output => output.textContent)).toEqual([String(value), String(value)]);
      expect(buttons.find(button => button.getAttribute("aria-label") === label)!.hasAttribute("disabled")).toBe(true);
    }
  });
  it("opens overlays when MediaQueryList only has the legacy addListener API (Safari < 14)", async () => {
    const addListener = vi.fn(), removeListener = vi.fn();
    vi.stubGlobal("window", { ...window, matchMedia: () => ({ matches: false, addListener, removeListener }) });
    const mounted = mount("overlays"); await settle(); mounted.flush();
    const trigger = elements(mounted.root, "button").find(button => button.textContent === "打开") as HTMLButtonElement;
    fire(trigger, "click"); mounted.flush();
    expect((elements(mounted.root, "dialog")[0] as HTMLDialogElement).open).toBe(true); expect(addListener).toHaveBeenCalled();
    disposers.splice(0).reverse().forEach(dispose => dispose()); expect(removeListener).toHaveBeenCalled();
  });
  it("traps Tab, closes on Escape and returns focus to the opener", async () => {
    const mounted = mount("overlays"); await settle(); mounted.flush();
    const trigger = elements(mounted.root, "button").find(button => button.textContent === "打开") as HTMLButtonElement;
    trigger.focus(); fire(trigger, "click"); mounted.flush();
    const dialog = elements(mounted.root, "dialog")[0] as HTMLDialogElement, buttons = elements(dialog, "button") as HTMLButtonElement[];
    expect(dialog.open).toBe(true); expect(document.activeElement).toBe(buttons[0]);
    const preventDefault = vi.fn(); buttons[buttons.length - 1]!.focus(); fire(dialog, "keydown", { key: "Tab", preventDefault });
    expect(preventDefault).toHaveBeenCalled(); expect(document.activeElement).toBe(buttons[0]);
    fire(dialog, "keydown", { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    fire(dialog, "keydown", { key: "Escape" }); mounted.flush(); expect(dialog.open).toBe(false); expect(document.activeElement).toBe(trigger);
  });
  it("supports native cancel and scrim click, but not clicks inside the dialog", async () => {
    const mounted = mount("overlays"); await settle();
    const trigger = elements(mounted.root, "button").find(button => button.textContent === "打开") as HTMLButtonElement;
    const dialog = elements(mounted.root, "dialog")[0] as HTMLDialogElement;
    trigger.focus(); fire(trigger, "click"); mounted.flush();
    fire(dialog, "click", { clientX: 150, clientY: 120 }); mounted.flush(); expect(dialog.open).toBe(true);
    fire(dialog, "click", { clientX: 1, clientY: 1 }); mounted.flush(); expect(dialog.open).toBe(false); expect(document.activeElement).toBe(trigger);
    fire(trigger, "click"); mounted.flush(); fire(dialog, "cancel"); mounted.flush(); expect(dialog.open).toBe(false);
  });
  it("keeps popovers nonmodal and closes them on outside interaction with focus return", async () => {
    const mounted = mount("overlays"); await settle(); mounted.flush();
    const trigger = elements(mounted.root, "button").find(button => button.textContent === "阅读设置") as HTMLButtonElement;
    trigger.focus(); fire(trigger, "click"); mounted.flush();
    const dialog = elements(mounted.root, "dialog")[2] as HTMLDialogElement;
    expect(dialog.open).toBe(true); expect(dialog.hasAttribute("aria-modal")).toBe(false);
    const preventDefault = vi.fn(); fire(dialog, "keydown", { key: "Tab", preventDefault }); expect(preventDefault).not.toHaveBeenCalled();
    const outsideHandlers = vi.mocked(document.addEventListener).mock.calls.filter(([name]) => name === "pointerdown");
    for (const [, handler] of outsideHandlers) (handler as EventListener)({ target: mounted.root } as unknown as Event);
    mounted.flush(); expect(dialog.open).toBe(false); expect(document.activeElement).toBe(trigger);
  });
  it("opens click menus, navigates menu items and switches to a sheet on phone", async () => {
    phone = true;
    const mounted = mount("overlays"); await settle(); mounted.flush();
    const trigger = elements(mounted.root, "button").find(button => button.getAttribute("aria-haspopup") === "menu") as HTMLButtonElement;
    trigger.focus(); fire(trigger, "keydown", { key: "ArrowDown" }); mounted.flush();
    const dialog = elements(mounted.root, "dialog")[3] as HTMLDialogElement, items = elements(dialog, "button").filter(button => button.getAttribute("role") === "menuitem");
    expect(dialog.getAttribute("data-presentation")).toBe("bottom-sheet"); expect(trigger.getAttribute("aria-expanded")).toBe("true"); expect(document.activeElement).toBe(items[0]);
    fire(dialog, "keydown", { key: "ArrowDown" }); expect(document.activeElement).toBe(items[1]);
    fire(dialog, "keydown", { key: "End" }); expect(document.activeElement).toBe(items[2]);
    fire(dialog, "keydown", { key: "Home" }); expect(document.activeElement).toBe(items[0]);
    phone = false; mediaChange?.(); mounted.flush(); expect(dialog.getAttribute("data-presentation")).toBe("menu");
    fire(items[0]!, "click"); mounted.flush(); expect(dialog.open).toBe(false); expect(document.activeElement).toBe(trigger);
    fire(trigger, "click"); mounted.flush(); expect(dialog.open).toBe(true);
    fire(dialog, "keydown", { key: "Escape" }); mounted.flush(); expect(dialog.open).toBe(false); expect(document.activeElement).toBe(trigger);
  });
});

describe("consolidated primitives", () => {
  it("keeps a real details fallback with links and POST fields, disabling JS-only actions", () => {
    const root = parseHtml(server.markup("consolidated"));
    const fallback = root.getElementsByTagName("details")[0]!;
    expect(fallback.getElementsByTagName("summary")[0]!.textContent).toContain("操作 · 菜单");
    expect(byRole(fallback, "link", "阅读").getAttribute("href")).toBe("/book/a?return_to=%2F#chapter");
    expect(byRole(fallback, "link", "下载").getAttribute("href")).toBe("/book/a/download");
    expect(byRole(fallback, "button", "编辑").hasAttribute("disabled")).toBe(true);
    const form = byAttribute(fallback, "action", "/book/a/archive");
    expect(form.getAttribute("method")).toBe("post"); expect(byName(form, "next").getAttribute("value")).toBe("/?q=书#books");
    expect(byRole(form, "button", "归档").getAttribute("type")).toBe("submit");
    expect(byRole(fallback, "button", "删除").hasAttribute("disabled")).toBe(true);
    expect(allByRole(fallback, "link", "不可用链接")).toHaveLength(0);
    expect(byAttribute(root, "aria-haspopup", "menu").hasAttribute("hidden")).toBe(true);
    const tabs = byRole(root, "navigation", "筛选链接");
    expect(byRole(tabs, "link", /全部/).getAttribute("aria-current")).toBe("page");
    expect(byRole(tabs, "link", /未读/).getAttribute("href")).toBe("/?q=书&filter=unread#books");
  });
  it("enhances mixed menus without losing their trigger, keyboard order or POST confirmation hook", async () => {
    const mounted = mount("consolidated"); await settle(); mounted.flush();
    const trigger = elements(mounted.root, "button", "aria-haspopup")[0] as HTMLButtonElement;
    expect(trigger.textContent).toContain("操作 · 菜单"); expect(trigger.hasAttribute("hidden")).toBe(false);
    expect(elements(mounted.root, "details")).toHaveLength(0);
    trigger.focus(); fire(trigger, "click"); mounted.flush();
    const dialog = elements(mounted.root, "dialog")[0] as HTMLDialogElement;
    const callback = elements(dialog, "button").find(button => button.textContent === "编辑")!;
    const read = elements(dialog, "a")[0]!;
    expect(document.activeElement).toBe(callback);
    fire(dialog, "keydown", { key: "ArrowDown" }); expect(document.activeElement).toBe(read);
    const preventDefault = vi.fn(); fire(read, "click", { button: 0, metaKey: true, preventDefault }); mounted.flush();
    expect(preventDefault).not.toHaveBeenCalled(); expect(dialog.open).toBe(false); expect(document.activeElement).toBe(trigger);
    fire(trigger, "click"); mounted.flush(); fire(callback, "click"); mounted.flush();
    expect(elements(mounted.root, "output", "data-callbacks")[0]!.textContent).toBe("1"); expect(dialog.open).toBe(false);
    fire(trigger, "click"); mounted.flush(); fire(dialog, "keydown", { key: "End" });
    const form = elements(dialog, "form").find(form => form.getAttribute("action") === "/book/a/archive")!;
    expect(document.activeElement).toBe(elements(form, "button")[0]);
    fire(form, "submit", { preventDefault }); mounted.flush();
    expect(preventDefault).toHaveBeenCalledOnce(); expect(elements(mounted.root, "output", "data-submits")[0]!.textContent).toBe("1");
    expect(dialog.open).toBe(false); expect(document.activeElement).toBe(trigger);
  });
  it("only intercepts ordinary left clicks in URL tabs", () => {
    const mounted = mount("consolidated");
    const tabs = elements(mounted.root, "nav")[0]!, unread = elements(tabs, "a")[1]!;
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      const preventDefault = vi.fn(); fire(unread, "click", { button: 0, preventDefault, ...modifiers }); mounted.flush();
      expect(preventDefault).not.toHaveBeenCalled(); expect(unread.hasAttribute("aria-current")).toBe(false);
    }
    const preventDefault = vi.fn(); fire(unread, "click", { button: 0, preventDefault }); mounted.flush();
    expect(preventDefault).toHaveBeenCalledOnce(); expect(unread.getAttribute("aria-current")).toBe("page");
    expect(unread.getAttribute("href")).toBe("/?q=书&filter=unread#books");
  });
  it("shares accessible star input/display and submits an empty value when cleared", () => {
    const mounted = mount("consolidated"), buttons = elements(mounted.root, "button");
    const star = buttons.find(button => button.getAttribute("aria-label") === "5 星")!;
    fire(star, "click"); mounted.flush(); expect(star.getAttribute("aria-pressed")).toBe("true");
    const field = elements(mounted.root, "input").find(input => input.getAttribute("name") === "rating") as HTMLInputElement;
    expect(field.value).toBe("5");
    expect(elements(mounted.root, "span").find(span => span.getAttribute("role") === "img")!.getAttribute("aria-label")).toBe("5 星");
    fire(buttons.find(button => button.getAttribute("aria-label") === "清除评分")!, "click"); mounted.flush();
    expect(field.value).toBe(""); expect(star.getAttribute("aria-pressed")).toBe("false");
    expect(elements(mounted.root, "output").map(output => output.textContent)).toContain("未评分");
  });
  it("uses a deterministic UTC SSR date and preserves calendar/elapsed/future/invalid formats", () => {
    const root = parseHtml(server.markup("consolidated")), time = root.getElementsByTagName("time")[0]!;
    expect(time.textContent).toBe("10-25"); expect(time.getAttribute("aria-label")).toBe("更新于 10-25");
    const now = new Date(2026, 9, 26, 12), date = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
    expect(server.relativeTimeLabel(date(26, 11, 58), now)).toBe("2 分钟前");
    expect(server.relativeTimeLabel(date(26, 10), now)).toBe("今天 10:00");
    expect(server.relativeTimeLabel(date(25, 21, 15), now)).toBe("昨天 21:15");
    expect(server.relativeTimeLabel(date(26, 10), now, { format: "elapsed" })).toBe("2 小时前");
    expect(server.relativeTimeLabel(date(23, 12), now)).toBe("3 天前");
    expect(server.relativeTimeLabel(date(1, 12), now)).toBe("10-01");
    expect(server.relativeTimeLabel(date(27, 12), now)).toBe("10-27");
    expect(server.relativeTimeLabel(date(27, 12), now, { clampFuture: true })).toBe("刚刚");
    expect(server.relativeTimeLabel("bad", now)).toBe(""); expect(server.relativeTimeLabel("bad", now, { invalidFallback: "bad" })).toBe("bad");
  });
});

it("checks all owned tokens, cover colors and minimum type sizes", () => {
  // Static theme emission keeps tokens available before phase-2 consumers exist.
  expect(readFileSync("src/styles.css", "utf8")).toContain("@theme static {");
  expect(execFileSync(process.execPath, ["scripts/check-ui-tokens.mjs", "--owned"], { encoding: "utf8" })).toContain("checks passed");
});
