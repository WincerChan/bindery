import { loadPreviewFont, type FontFamily } from "../../../client/kindle/fonts";
import type { KindleModel, PairedDevice } from "../../../client/kindle/identity";
import { kindlePageGeometry, type KindleMarginPreset } from "../../../client/kindle/margins";
import { previewAnchorPage, previewPagination } from "./model";
import type { PageGeometry } from "../../../client/devices/typeset";
export type { PageGeometry } from "../../../client/devices/typeset";

/** A font registration belongs to exactly one isolated document. Late loads cannot resurrect it. */
export class DocumentFonts {
  private generation = 0;
  private faces: FontFace[] = [];
  constructor(private document: Document) {}
  clear() {
    this.generation++;
    for (const face of this.faces) this.document.fonts.delete(face);
    this.faces = [];
  }
  async load(device: PairedDevice, family: FontFamily, alias = family.name) {
    this.clear();
    const generation = this.generation;
    // All styles are loaded together, so bold/italic samples and EPUB emphasis use the real files.
    const faces = await Promise.all(family.fonts.map(font => loadPreviewFont(device, font, alias)));
    if (generation !== this.generation) return;
    for (const face of faces) { this.document.fonts.add(face); this.faces.push(face); }
  }
}

interface TextAnchor { node: Text; offset: number }
// Desktop CJK families a book may name without embedding; an e-reader does not have them.
const SYSTEM_FAMILIES = ["宋体", "SimSun", "新宋体", "NSimSun", "黑体", "SimHei", "楷体", "KaiTi", "楷体_GB2312", "仿宋", "FangSong", "仿宋_GB2312", "微软雅黑", "Microsoft YaHei", "华文宋体", "STSong", "华文楷体", "STKaiti", "华文仿宋", "STFangsong", "华文黑体", "STHeiti", "Songti SC", "Kaiti SC", "Heiti SC"];
/** Splits a CSS list at top-level commas. */
const cssList = (value: string) => { const parts: string[] = []; let depth = 0, quote = "", start = 0; for (let i = 0; i < value.length; i++) { const ch = value[i]; if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = ""; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === "(") depth++; else if (ch === ")") depth--; else if (ch === "," && !depth) { parts.push(value.slice(start, i).trim()); start = i + 1; } } parts.push(value.slice(start).trim()); return parts.filter(Boolean); };
export interface PreviewPage { page: number; count: number }

export function previewTurnKey(event: KeyboardEvent, turn: (direction: -1 | 1) => void) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
    (event.target as Element | null)?.closest?.("input, textarea, select, button, a, [contenteditable]")) return;
  const direction = event.key === "ArrowLeft" || event.key === "PageUp" ? -1 : event.key === "ArrowRight" || event.key === "PageDown" ? 1 : 0;
  if (direction) { event.preventDefault(); turn(direction); }
}

/** No wrapper: body remains the percentage containing block for profile selectors. */
export class PreviewDocument {
  private style: HTMLStyleElement;
  private base: HTMLStyleElement;
  private fonts: DocumentFonts;
  private fontKey = "";
  private geometry: PageGeometry = kindlePageGeometry("KPW3", "narrow");
  private page = 1;
  private count = 1;
  private anchor?: TextAnchor;
  private disposed = false;
  private lastPage = false;
  private initialized = false;
  private layoutPending = false;
  private originalStyles = new Map<HTMLElement, string>();
  private cleanups: (() => void)[] = [];
  private originalMarker: string | null;
  private spacers: HTMLElement[] = [];
  private fontsDetached = false;
  private key = (event: KeyboardEvent) => previewTurnKey(event, direction => this.turn(direction));
  private click = (event: MouseEvent) => {
    if ((event.target as Element | null)?.closest?.("a")) { event.preventDefault(); return; }
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      this.document.getSelection()?.isCollapsed === false || (event.target as Element | null)?.closest?.("button,input,textarea,select,[contenteditable]")) return;
    if (event.clientX < this.geometry.width / 3) this.turn(-1);
    else if (event.clientX > this.geometry.width * 2 / 3) this.turn(1);
  };
  constructor(private document: Document, private change: (page: PreviewPage) => void = () => {}, private boundary: (direction: -1 | 1) => void = () => {}, initialPage = 1) {
    this.fonts = new DocumentFonts(document);
    this.base = document.createElement("style");
    this.style = document.createElement("style");
    this.style.setAttribute("data-bindery-profile", "");
    this.originalMarker = document.documentElement.getAttribute("data-bindery-kindle");
    document.documentElement.setAttribute("data-bindery-kindle", "");
    this.page = initialPage;
    this.lastPage = initialPage === Number.MAX_SAFE_INTEGER;
    // Device baseline, book CSS, profile CSS. Inline geometry also neutralises author !important
    // and inline body margins, while all author typography remains in the cascade.
    document.head.insertBefore(this.base, document.head.firstChild);
    document.head.append(this.style);
    this.setDevice("KPW3", "narrow");
    this.refresh();
    document.addEventListener("click", this.click);
    document.addEventListener("keydown", this.key);
    const refresh = () => { if (!this.disposed) this.refresh(); };
    for (const image of Array.from(document.getElementsByTagName("img"))) {
      image.addEventListener("load", refresh); image.addEventListener("error", refresh);
      this.cleanups.push(() => { image.removeEventListener("load", refresh); image.removeEventListener("error", refresh); });
    }
    // Stylesheet loads can start another font cycle after the initial fonts.ready has settled.
    document.addEventListener("load", refresh, true);
    this.cleanups.push(() => document.removeEventListener("load", refresh, true));
    document.fonts.addEventListener?.("loadingdone", refresh);
    this.cleanups.push(() => document.fonts.removeEventListener?.("loadingdone", refresh));
    void document.fonts.ready?.then(refresh);
  }
  setDevice(model: KindleModel, preset: KindleMarginPreset) { this.setGeometry(kindlePageGeometry(model, preset)); }
  setGeometry(geometry: PageGeometry) {
    if (this.initialized && !this.layoutPending) this.anchor = this.capture() ?? this.anchor;
    this.layoutPending = true;
    const { width, height, emPx, lineHeight, side, fontFamily } = geometry;
    let { top, bottom } = geometry, left = side, right = side, insetTop = 0, insetBottom = 0;
    if (geometry.bookInsets) {
      const inset = this.bookInsets(emPx);
      // Side insets repeat on every page; top and bottom ones open and close the chapter's flow.
      left = Math.max(0, side + inset.left); right = Math.max(0, side + inset.right); insetTop = inset.top; insetBottom = inset.bottom;
    }
    const fallback = geometry.fallbackSources ?? 'url("data:,")';
    if (geometry.embeddedFontsOnly) this.detachSystemFonts(fallback);
    const column = Math.max(1, width - left - right), gap = left + right, contentHeight = height - top - bottom;
    this.geometry = { ...geometry, column, gap, contentHeight };
    this.setSpacers(insetTop, insetBottom);
    const root = { width: `${width}px`, "min-width": "0", "max-width": "none", height: `${height}px`, "min-height": "0", "max-height": "none", margin: "0", padding: "0", border: "0", "box-sizing": "content-box", overflow: "hidden", position: "relative", "scroll-behavior": "auto", "scroll-snap-type": "none", "overflow-anchor": "none", "scrollbar-width": "none", direction: "ltr", "writing-mode": "horizontal-tb" };
    const body = { display: "block", position: "static", float: "none", width: `${column}px`, "min-width": "0", "max-width": "none", height: `${contentHeight}px`, "min-height": "0", "max-height": "none", margin: left === right ? `${top}px ${left}px ${bottom}px` : `${top}px ${right}px ${bottom}px ${left}px`, padding: "0", border: "0", "box-sizing": "content-box", overflow: "visible", "column-width": `${column}px`, "column-gap": `${gap}px`, "column-count": "auto", "column-fill": "auto", direction: "ltr", "writing-mode": "horizontal-tb" };
    const declarations = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${key}: ${value} !important;`).join(" ");
    this.base.textContent = `html { font-size: ${emPx}px; ${declarations(root)} } body { ${declarations(body)} overflow-wrap: anywhere; }
      body { line-height: ${lineHeight};${fontFamily ? ` font-family: ${fontFamily};` : ""} }${geometry.embeddedFontsOnly ? `
      ${SYSTEM_FAMILIES.map(family => `@font-face { font-family: "${family}"; src: ${fallback}; }`).join(" ")}` : ""}
      html[data-bindery-kindle]::after { content: "" !important; display: block !important; position: absolute !important; left: var(--bindery-page-end, 0px) !important; top: 0 !important; width: 1px !important; height: 1px !important; margin: 0 !important; padding: 0 !important; border: 0 !important; pointer-events: none !important; }
      ::-webkit-scrollbar { display: none !important; } img, svg { max-width: 100%; max-height: ${contentHeight}px; }`;
    this.force(this.document.documentElement, root);
    this.force(this.document.body, body);
  }
  /** The book's own html + body margin and padding, measured without the preview's forced geometry. */
  private bookInsets(emPx: number) {
    const doc = this.document, view = doc.defaultView, elements = [doc.documentElement, doc.body];
    const inline = elements.map(element => element.style.cssText), base = this.base.textContent;
    for (const element of elements) if (this.originalStyles.has(element)) element.style.cssText = this.originalStyles.get(element)!;
    // Zero the UA body margin underneath the book's CSS: only author spacing counts.
    this.base.textContent = `html { font-size: ${emPx}px; } body { margin: 0; }`;
    const sides = ["top", "right", "bottom", "left"] as const, total = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const element of elements) {
      const style = view?.getComputedStyle(element);
      for (const side of sides) total[side] += (Number.parseFloat(style?.getPropertyValue(`margin-${side}`) ?? "") || 0) + (Number.parseFloat(style?.getPropertyValue(`padding-${side}`) ?? "") || 0);
    }
    elements.forEach((element, index) => { element.style.cssText = inline[index]; });
    this.base.textContent = base;
    return total;
  }
  private setSpacers(top: number, bottom: number) {
    for (const spacer of this.spacers) spacer.remove();
    this.spacers = [];
    for (const [height, first] of [[top, true], [bottom, false]] as const) {
      if (height <= 0) continue;
      const spacer = this.document.createElement("div");
      spacer.setAttribute("data-bindery-inset", ""); spacer.setAttribute("aria-hidden", "true");
      spacer.setAttribute("style", `display: block !important; height: ${height}px !important; margin: 0 !important; padding: 0 !important; border: 0 !important;`);
      this.document.body.insertBefore(spacer, first ? this.document.body.firstChild : null);
      this.spacers.push(spacer);
    }
  }
  /** Drops `local()` sources from the book's @font-face rules; a rule left with none uses the reader's fallback. */
  private detachSystemFonts(fallback: string) {
    if (this.fontsDetached) return;
    this.fontsDetached = true;
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (/^@font-face\b/i.test(rule.cssText)) {
          const style = (rule as CSSFontFaceRule).style, sources = cssList(style.getPropertyValue("src")).filter(source => !/^local\(/i.test(source));
          style.setProperty("src", sources.length ? sources.join(", ") : fallback);
        } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(this.document.styleSheets)) { try { visit(sheet.cssRules); } catch { /* Cross-origin sheets are not book CSS. */ } }
  }
  private force(element: HTMLElement, values: Record<string, string>) {
    // Preserve the whole inline declaration block: shorthands can replace mixed-priority longhands.
    if (!this.originalStyles.has(element)) this.originalStyles.set(element, element.style.cssText);
    for (const [name, value] of Object.entries(values)) element.style.setProperty(name, value, "important");
  }
  turn(direction: -1 | 1) {
    const next = this.page + direction;
    if (next < 1 || next > this.count) { this.boundary(direction); return; }
    this.lastPage = false;
    this.page = next;
    this.anchor = undefined;
    this.refresh();
  }
  open(page: number) {
    this.page = page; this.lastPage = page === Number.MAX_SAFE_INTEGER; this.anchor = undefined;
    this.refresh();
    this.lastPage = false;
  }
  private refresh() {
    if (this.disposed) return;
    const root = this.document.documentElement, scroller = this.document.scrollingElement ?? root;
    this.force(root, { "--bindery-page-end": "0px" });
    const metrics = previewPagination(this.geometry.width, scroller.scrollWidth || this.geometry.width, this.lastPage ? Number.MAX_SAFE_INTEGER : this.page);
    let desired = metrics.page;
    if (!this.lastPage && this.anchor?.node.isConnected) {
      const range = this.document.createRange(), { node, offset } = this.anchor;
      range.setStart(node, Math.min(offset, node.length)); range.setEnd(node, Math.min(node.length, offset + 1));
      const rect = range.getClientRects()[0];
      if (rect) desired = previewAnchorPage(rect.left, scroller.scrollLeft, metrics.step);
    }
    const position = previewPagination(metrics.step, metrics.end, desired);
    // A root pseudo-element fills only the last gutter. It cannot create a new body column,
    // match body > *, or feed its own previous width back into the page count.
    this.force(root, { "--bindery-page-end": `${position.end - 1}px` });
    scroller.scrollLeft = position.left; scroller.scrollTop = 0;
    this.page = position.page; this.count = position.count;
    this.anchor = this.capture();
    this.initialized = true; this.layoutPending = false;
    this.change({ page: this.page, count: this.count });
  }
  private capture(): TextAnchor | undefined {
    const doc = this.document;
    if (!doc.createRange || !doc.createTreeWalker) return;
    const caret = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const { top, width, height } = this.geometry;
    // Probe from the physical left edge, including text expanded into the device gutter.
    const position = caret.caretPositionFromPoint?.(2, top + 2), range = position ? null : caret.caretRangeFromPoint?.(2, top + 2);
    const node = position?.offsetNode ?? range?.startContainer;
    if (node?.nodeType === 3 && doc.body.contains(node)) {
      const offset = position?.offset ?? range?.startOffset ?? 0, probe = doc.createRange(), text = node as Text;
      probe.setStart(text, Math.min(offset, text.length)); probe.setEnd(text, Math.min(offset + 1, text.length));
      if (Array.from(probe.getClientRects()).some(rect => rect.right > 0 && rect.left < width && rect.bottom > 0 && rect.top < height)) return { node: text, offset };
    }
    const walker = doc.createTreeWalker(doc.body, 4);
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (!text.data.trim() || text.parentElement?.closest("script,style")) continue;
      const textRange = doc.createRange(); textRange.selectNodeContents(text);
      if (!Array.from(textRange.getClientRects()).some(rect => rect.right > 0 && rect.left < width && rect.bottom > 0 && rect.top < height)) continue;
      let low = 0, high = text.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        textRange.setStart(text, middle); textRange.setEnd(text, middle + 1);
        const rect = textRange.getBoundingClientRect();
        if (rect.right <= 0 || rect.bottom <= 0) low = middle + 1; else high = middle;
      }
      return { node: text, offset: low };
    }
  }
  async update(css: string | null, device: PairedDevice | null, family?: FontFamily) {
    if (!this.layoutPending) this.anchor = this.capture() ?? this.anchor;
    if (css !== null) this.style.textContent = css;
    this.refresh();
    const key = device && family ? `${device.identity.id}:${family.name}:${family.fonts.map(font => `${font.filename}:${font.size}`).join("|")}` : "";
    void this.document.fonts.ready?.then(() => { if (!this.disposed) this.refresh(); });
    if (key === this.fontKey) { this.lastPage = false; return; }
    this.fontKey = key;
    this.fonts.clear();
    this.refresh();
    if (device && family) {
      try { await this.fonts.load(device, family); if (!this.disposed) this.refresh(); }
      catch (error) { if (this.fontKey === key) { this.fontKey = ""; throw error; } }
    }
    this.lastPage = false;
  }
  destroy() {
    this.disposed = true; this.fonts.clear(); this.cleanups.forEach(cleanup => cleanup());
    this.style.remove(); this.base.remove(); for (const spacer of this.spacers) spacer.remove(); this.document.removeEventListener("click", this.click); this.document.removeEventListener("keydown", this.key);
    for (const [element, css] of this.originalStyles) element.style.cssText = css;
    if (this.originalMarker === null) this.document.documentElement.removeAttribute("data-bindery-kindle");
    else this.document.documentElement.setAttribute("data-bindery-kindle", this.originalMarker);
  }
}
