import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ReaderFrames, type ReaderLocation } from "../src/features/reader/frame";
import { backgroundOptions, brightBgColors, defaultSettings, dimBgColors, normalizeSettings, readerFonts, storageKey, type ReaderData, type ReaderSettings } from "../src/features/reader/model";
import { clientDocument } from "./support/client-dom";

const template = readFileSync("tests-ts/fixtures/parity/reader/preview-template.html", "utf8");
const data: ReaderData = {
  book: { book_id: "id", title: "book", author: null, cover_url: null },
  sections: [{ title: "one", item_path: "one.xhtml" }, { title: "two", item_path: "two.xhtml" }],
  section_index: 0, initial_progress: null, return_to: "/",
};
interface ReferenceReader extends ReaderSettings {
  init(): void;
  _persist(): void;
  applyToFrame(options: { frameKey: string; primeOnly: boolean }): void;
  _updateFrameVars(doc: Document, x: number, y: number, font: string, size: number, lineHeight: number, bg: string, color: string): void;
  _computeTailPad(maxLeft: number, step: number): number;
}
/** Execute the reference template's actual reader JS, with inert Alpine/browser hooks. */
function referenceReader(raw: unknown = null) {
  const values: Record<string, unknown> = {
    "book.book_id|tojson": "id", "book.title|tojson": "book", "initial_progress|tojson": null,
    "sections_payload|tojson": data.sections, section_index: 0, toc_count: 2, "return_to|tojson": "/",
  };
  const source = template.match(/<script>([\s\S]*?)<\/script>/)![1]
    .replace(/\{\{\s*(.*?)\s*\}\}/g, (_all, key: string) => {
      if (key === "book.book_id") return "id"; // Literal URL segment in the template.
      if (!(key in values)) throw new Error(`Unmapped reference input: ${key}`);
      return JSON.stringify(values[key]);
    })
    .replace("    return {\n      tocOpen:", "    globalThis.reference = { storageKey, fonts, brightBgColors, dimBgColors };\n    return {\n      tocOpen:");
  let stored = raw === null ? null : JSON.stringify(raw);
  const context = {
    URLSearchParams,
    window: { location: new URL("https://reader.test/book/id/preview/0"), addEventListener() {} },
    localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } },
    setInterval: () => 1, requestAnimationFrame: () => 1,
  };
  const result = runInNewContext(source + "; ({ reader: binderyReader(), reference });", context) as {
    reader: ReferenceReader; reference: { storageKey: string; fonts: Record<string, string>; brightBgColors: Record<string, string>; dimBgColors: Record<string, string> };
  };
  Object.assign(result.reader, {
    $watch() {}, _updateTimeNow() {}, _sectionIndexFromLocation: () => null, _bindFrameLoad() {},
    _loadSectionIntoFrame() {}, _updateHistoryForSection() {}, _scrollCurrentTocIntoView() {},
    _persistProgressSoon() {}, _scheduleChapterPreload() {},
  });
  return { ...result, settings() { result.reader.init(); result.reader._persist(); return JSON.parse(stored!); } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("reader settings against the legacy template", () => {
  it("keeps the storage key, first-use defaults, ordered labels, palettes and fonts", () => {
    const py = referenceReader();
    expect(storageKey).toBe(py.reference.storageKey);
    expect(defaultSettings).toEqual(py.settings());
    expect(brightBgColors).toEqual(py.reference.brightBgColors);
    expect(dimBgColors).toEqual(py.reference.dimBgColors);
    for (const [name, font] of Object.entries(py.reference.fonts)) expect(readerFonts[name as keyof typeof readerFonts]).toBe(font);
    const labels = [...template.matchAll(/@click="readerBg = '([^']+)'"[\s\S]*?>([^<]+)<\/button>/g)].map(match => [match[1], match[2]]);
    expect(backgroundOptions.map(option => [option.value, option.label])).toEqual(labels);
    for (const option of backgroundOptions) expect(option).toMatchObject({ bright: brightBgColors[option.value], dim: dimBgColors[option.value] });
  });
  it.each([
    {}, { styleMode: "custom", fontFamily: "sans", readerBg: "slate", brightnessMode: "dim", textAlignMode: "center" },
    { fontSize: "28px", lineHeight: "0.85", pagePaddingX: "-1px", pagePaddingY: "48.9" },
    { fontSize: "1e2", lineHeight: 1.1, pagePaddingX: "1e2", pagePaddingY: "0" },
    { fontSize: "0", lineHeight: 0, pagePaddingX: -100, pagePaddingY: 100 },
    { fontSize: "bad", lineHeight: "Infinity", pagePaddingX: "bad", pagePaddingY: null },
    { fontSize: "11.9", lineHeight: -1, pagePaddingX: "0", pagePaddingY: "0" },
    { fontSize: 900, lineHeight: 99, pagePaddingX: 48, pagePaddingY: -1 },
    { fontSize: -1, lineHeight: 1.11, styleMode: "bad", fontFamily: "bad", textAlignMode: "bad" },
    ...backgroundOptions.map(option => ({ ...defaultSettings, readerBg: option.value })),
  ])("loads saved settings using the reference clamp/fallback rules: %j", raw => {
    expect(normalizeSettings(raw)).toEqual(referenceReader(raw).settings());
  });
  it("rejects malformed values and preserves the existing TS kai font setting", () => {
    for (const raw of [null, [], "custom", 17]) expect(normalizeSettings(raw)).toEqual(defaultSettings);
    expect(normalizeSettings({ fontFamily: "kai" }).fontFamily).toBe("kai");
    expect(normalizeSettings({ fontFamily: ["sans"], readerBg: "invalid", textAlignMode: "left;color:red" })).toMatchObject({ fontFamily: "serif", readerBg: "book", textAlignMode: "justify" });
  });
  it("retains numeric zero padding instead of reproducing the legacy implementation's truthiness bug", () => {
    const saved = { ...defaultSettings, styleMode: "custom", pagePaddingX: 0, pagePaddingY: 0 };
    expect(normalizeSettings(saved)).toEqual(saved);
    expect(referenceReader(saved).settings()).toMatchObject({ pagePaddingX: 10, pagePaddingY: 12 });
    expect(normalizeSettings({ fontSize: 0 }).fontSize).toBe(11);
  });
});

function inlineStyle() {
  const entries = new Map<string, { value: string; priority: string }>();
  return {
    getPropertyValue: (name: string) => entries.get(name)?.value || "",
    getPropertyPriority: (name: string) => entries.get(name)?.priority || "",
    setProperty(name: string, value: string, priority = "") { entries.set(name, { value, priority }); },
    removeProperty(name: string) { const value = entries.get(name)?.value || ""; entries.delete(name); return value; },
  } as unknown as CSSStyleDeclaration;
}

/** Geometry inputs stand in for layout; this DOM does not claim to render CSS. */
function frameFixture(viewport = 598, marginX = viewport * .01, paddingX = 8, columns = 3) {
  const doc = clientDocument(), create = doc.createElement.bind(doc);
  const viewportBox = { width: viewport, marginX, paddingX, columns, rawRight: undefined as number | undefined };
  const width = () => Math.round(Math.min(599, viewportBox.width - 2 * viewportBox.marginX - 2 * viewportBox.paddingX));
  doc.createElement = ((tag: string) => {
    const element = create(tag) as HTMLElement;
    Object.defineProperty(element, "style", { value: inlineStyle() });
    // These fixtures contain no images/search marks or caret geometry.
    element.querySelectorAll = (() => []) as unknown as typeof element.querySelectorAll;
    element.getBoundingClientRect = () => ({ left: viewportBox.marginX + viewportBox.paddingX, top: 0, right: viewportBox.width - viewportBox.marginX - viewportBox.paddingX, bottom: 900 } as DOMRect);
    if (tag === "div") {
      Object.defineProperty(element, "clientWidth", { get: width });
      Object.defineProperty(element, "scrollWidth", { get() {
        const vars = doc.documentElement.style;
        const x = Math.max(0, parseFloat(vars.getPropertyValue("--bindery-page-padding-x")) || 0);
        const pitch = parseFloat(vars.getPropertyValue("--bindery-column-width")) + parseFloat(vars.getPropertyValue("--bindery-column-gap"));
        const rawRight = viewportBox.rawRight ?? viewportBox.columns * pitch - x;
        const offset = parseFloat(vars.getPropertyValue("--bindery-page-tail-offset")) || 0;
        const pad = parseFloat(vars.getPropertyValue("--bindery-page-tail-pad")) || 0;
        return Math.max(width(), rawRight, width() + offset + pad);
      } });
      element.scrollLeft = 0;
      element.scrollTo = ((options: ScrollToOptions) => { element.scrollLeft = options.left || 0; }) as typeof element.scrollTo;
    }
    return element;
  }) as typeof doc.createElement;
  Object.defineProperty(doc.documentElement, "style", { value: inlineStyle() });
  Object.defineProperty(doc.documentElement, "classList", { value: { toggle() {} } });
  const head = doc.createElement("head"), body = doc.createElement("body");
  body.style.setProperty("margin", `0 ${marginX}px`); body.style.setProperty("padding", `${paddingX}px`);
  body.style.setProperty("font-family", "Book Font", "important");
  doc.documentElement.appendChild(head); doc.documentElement.appendChild(body);
  Object.defineProperties(doc, {
    head: { value: head }, body: { value: body }, fonts: { value: { ready: Promise.resolve() } },
    URL: { value: "https://reader.test/book/id/epub/one.xhtml" }, readyState: { value: "complete" }, contentType: { value: "text/html" },
  });
  doc.createTreeWalker = (() => ({ nextNode: () => null })) as unknown as typeof doc.createTreeWalker;
  doc.addEventListener = () => {}; doc.removeEventListener = () => {};
  const frame = Object.assign(new EventTarget(), { contentDocument: doc, clientWidth: viewport, inert: false, src: "" }) as unknown as HTMLIFrameElement;
  vi.stubGlobal("window", { location: new URL("https://reader.test/book/id/preview/0") });
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const changes: ReaderLocation[] = [], errors: string[] = [];
  const frames = new ReaderFrames(data, [frame, Object.assign(new EventTarget(), { src: "" }) as HTMLIFrameElement, Object.assign(new EventTarget(), { src: "" }) as HTMLIFrameElement], { section: 0, page: 1 }, value => changes.push(value), () => {}, error => { if (error) errors.push(error); });
  expect(errors).toEqual([]);
  const vars = doc.documentElement.style;
  return { frames, doc, body, vars, changes, viewportBox, width,
    scroller: doc.getElementById("bindery-reader-scroller") as HTMLDivElement,
    pages: doc.getElementById("bindery-reader-pages") as HTMLDivElement,
    css: () => head.firstChild!.textContent!,
  };
}

function declarations(css: string, selector: string) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const rule = rules.find(match => match[1].trim() === selector);
  if (!rule) throw new Error(`Missing CSS selector: ${selector}`);
  return Object.fromEntries(rule[2].split(";").filter(Boolean).map(part => {
    const colon = part.indexOf(":"); return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }));
}

function resolvedDeclarations(css: string, selector: string, vars: CSSStyleDeclaration, styleMode: ReaderSettings["styleMode"]) {
  const expanded = css.replace(/(html\[data-bindery-style="custom"\] )?#bindery-reader-pages :is\(([^)]+)\)/g, (_match, prefix: string | undefined, tags: string) => tags.split(",").map(tag => `${prefix || ""}#bindery-reader-pages ${tag}`).join(","));
  const result: Record<string, string> = {};
  for (const match of expanded.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map(value => styleMode === "custom" ? value.trim().replace(/^html(?:\.bindery-mode-custom|\[data-bindery-style="custom"\])\s+/, "") : value.trim());
    if (!selectors.includes(selector)) continue;
    for (const part of match[2].split(";").filter(Boolean)) {
      const colon = part.indexOf(":");
      result[part.slice(0, colon).trim()] = part.slice(colon + 1).trim().replace(/var\((--[^,)]+)(?:,([^)]*))?\)/g, (_all, name: string, fallback: string) => vars.getPropertyValue(name) || fallback || "");
    }
  }
  return result;
}

describe("iframe style and pagination parity", () => {
  it("keeps author margins/padding and matches reference heights, media and break rules", () => {
    const f = frameFixture(), py = referenceReader();
    Object.assign(py.reader, { getFrame: () => ({ contentDocument: f.doc }) });
    py.reader.applyToFrame({ frameKey: "a", primeOnly: true });
    const referenceCSS = f.doc.getElementById("bindery-reader-style")!.textContent!;
    const css = f.css();
    for (const selector of ["img,svg,video", "h1,h2,h3,h4,h5,h6,pre,blockquote,figure,table"]) {
      expect(declarations(css, selector)).toEqual(declarations(referenceCSS, selector));
    }
    for (const selector of ["html,body", "#bindery-reader-scroller", "#bindery-reader-pages"]) expect(declarations(css, selector).height).toBe("99%!important");
    expect(declarations(css, "html,body")).not.toHaveProperty("margin");
    expect(declarations(css, "html,body")).not.toHaveProperty("padding");
    expect(declarations(css, "html,body")).not.toHaveProperty("width");
    expect(f.body.style.getPropertyValue("margin")).toBe("0 5.98px");
    expect(f.body.style.getPropertyValue("padding")).toBe("8px");
    expect(f.doc.getElementById("bindery-reader-tail")!.getAttribute("aria-hidden")).toBe("true");
    expect(css).not.toMatch(/object-fit|max-height|white-space|overflow-wrap/);
    f.frames.destroy();
  });
  it.each(["bright", "dim"] as const)("matches book/custom theme variables for all backgrounds (%s)", brightnessMode => {
    const f = frameFixture();
    for (const { value: readerBg } of backgroundOptions) for (const styleMode of ["book", "custom"] as const) {
      const settings = { ...defaultSettings, brightnessMode, readerBg, styleMode };
      f.frames.configure(settings);
      const py = referenceReader(), reference = frameFixture();
      Object.assign(py.reader, settings);
      const bg = (brightnessMode === "dim" ? py.reference.dimBgColors : py.reference.brightBgColors)[readerBg];
      py.reader._updateFrameVars(reference.doc, styleMode === "custom" ? settings.pagePaddingX : 0, styleMode === "custom" ? settings.pagePaddingY : 0, readerFonts.serif, settings.fontSize, settings.lineHeight, bg, brightnessMode === "dim" ? "#e5e7eb" : "#111827");
      for (const key of ["font-family", "font-size", "line-height", "reader-bg", "reader-text", "page-padding-x", "page-padding-y", "text-align", "text-justify", "column-width", "column-gap", "page-step"]) {
        expect(f.vars.getPropertyValue(`--bindery-${key}`), key).toBe(reference.vars.getPropertyValue(`--bindery-${key}`));
      }
      // Book mode preserves author text/background styling in both brightness modes.
      if (styleMode === "book") expect(f.css()).not.toContain("color:var(--bindery-reader-text");
      reference.frames.destroy();
    }
    f.frames.destroy();
  });
  it.each(["book", "custom"] as const)("matches reference CSS declarations in %s mode except the documented integer column width", styleMode => {
    const f = frameFixture(), py = referenceReader();
    const settings: ReaderSettings = { ...defaultSettings, styleMode, brightnessMode: "dim", readerBg: "paper", textAlignMode: "left" };
    f.frames.configure(settings);
    const actualCSS = f.css();
    Object.assign(py.reader, settings, { getFrame: () => ({ contentDocument: f.doc }) });
    py.reader.applyToFrame({ frameKey: "a", primeOnly: true });
    const referenceCSS = f.doc.getElementById("bindery-reader-style")!.textContent!;
    for (const selector of ["html", "body", "#bindery-reader-scroller", "#bindery-reader-pages", "#bindery-reader-tail", ...["p", "li", "div", "span", "b", "strong", "blockquote", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"].map(tag => `#bindery-reader-pages ${tag}`)]) {
      const actual = resolvedDeclarations(actualCSS, selector, f.vars, styleMode), expected = resolvedDeclarations(referenceCSS, selector, f.vars, styleMode);
      if (selector === "#bindery-reader-pages") {
        expect(actual.width).toBe(`${f.width()}px!important`); expect(actual["min-width"]).toBe(`${f.width()}px!important`);
        delete actual.width; delete actual["min-width"]; delete expected.width; delete expected["min-width"];
      }
      expect(actual, selector).toEqual(expected);
    }
    f.frames.destroy();
  });
  it.each(["justify", "left", "center", "right"] as const)("applies custom typography and %s justification, then restores inline book typography", textAlignMode => {
    const f = frameFixture();
    f.frames.configure({ ...defaultSettings, styleMode: "custom", textAlignMode });
    expect(f.vars.getPropertyValue("--bindery-text-justify")).toBe(textAlignMode === "justify" ? "inter-ideograph" : "auto");
    expect(f.body.style.getPropertyValue("font-family")).toBe(readerFonts.serif);
    expect(f.pages.style.getPropertyValue("text-align")).toBe(textAlignMode);
    expect(f.pages.style.getPropertyPriority("text-align")).toBe("important");
    expect(f.css()).toContain("background-image:none!important");
    expect(f.css()).not.toContain("#bindery-reader-pages *");
    f.frames.configure(defaultSettings);
    expect(f.body.style.getPropertyValue("font-family")).toBe("Book Font");
    expect(f.body.style.getPropertyPriority("font-family")).toBe("important");
    expect(f.pages.style.getPropertyValue("text-align")).toBe("");
    f.frames.destroy();
  });
  it.each([
    [598, 5.98, 0, "book", 9, 11], [388, 0, 8, "book", 9, 11],
    [598, 5.98, 8, "custom", 9, 11], [388, 3.88, 8, "custom", -1, -1],
    [598, 8, 8, "custom", 48, 48], [1440, 8, 8, "custom", 0, -1],
  ] as const)("keeps exact steps and last-page tail with viewport/margin/padding %j/%j/%j (%s, %j/%j)", (viewport, margin, padding, styleMode, x, y) => {
    const f = frameFixture(viewport, margin, padding, 100);
    f.frames.configure({ ...defaultSettings, styleMode, pagePaddingX: x, pagePaddingY: y });
    const effectiveX = styleMode === "book" ? 0 : Math.max(0, x);
    expect(f.vars.getPropertyValue("--bindery-page-padding-x")).toBe(`${styleMode === "book" ? 0 : x}px`);
    expect(f.vars.getPropertyValue("--bindery-page-padding-y")).toBe(`${styleMode === "book" ? 0 : y}px`);
    const columnWidth = parseFloat(f.vars.getPropertyValue("--bindery-column-width")), gap = parseFloat(f.vars.getPropertyValue("--bindery-column-gap"));
    expect(columnWidth + gap).toBe(f.width());
    expect(effectiveX + columnWidth).toBeLessThanOrEqual(f.width());
    expect(effectiveX + columnWidth + gap).toBeGreaterThanOrEqual(f.width());
    expect(f.vars.getPropertyValue("--bindery-page-tail-pad")).toBe(`${effectiveX}px`);
    for (let page = 2; page <= 100; page++) {
      f.frames.turn(1);
      expect(f.scroller.scrollLeft).toBe((page - 1) * f.width());
      expect(f.changes.at(-1)).toMatchObject({ page, pageCount: 100 });
    }
    expect(f.scroller.scrollLeft).toBe(f.scroller.scrollWidth - f.width());
    f.frames.turn(-1); expect(f.changes.at(-1)?.page).toBe(99);
    // A resize/settings refresh must discard the old tail instead of counting it again.
    f.viewportBox.width -= 20;
    f.frames.configure({ ...defaultSettings, styleMode, pagePaddingX: x, pagePaddingY: y });
    expect(f.scroller.scrollLeft).toBe(98 * f.width());
    expect(f.changes.at(-1)?.pageCount).toBe(100);
    f.frames.destroy();
  });
  it.each([0, .4, .5, .6, 9, 569.5, 569.6])("matches the reference tail epsilon with remainder %j", remainder => {
    const f = frameFixture(598, 5.98, 8), py = referenceReader();
    f.viewportBox.rawRight = f.width() * 2 + remainder;
    f.frames.configure(defaultSettings);
    expect(parseFloat(f.vars.getPropertyValue("--bindery-page-tail-pad"))).toBeCloseTo(py.reader._computeTailPad(f.width() + remainder, f.width()), 9);
    f.frames.destroy();
  });
});
