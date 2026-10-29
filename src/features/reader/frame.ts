import { contentUrl, defaultSettings, fractionPage, pageEpsilon, pageMetrics, readerFonts, textMatches, type ReaderData, type ReaderSettings } from "./model";
import { readerPaper } from "./reader-presentation";
type ReaderFrameData = { sections: ReaderData["sections"] } & ({ book: Pick<ReaderData["book"], "book_id"> } | { html: string });
interface Anchor { node: Text; offset: number }
interface ReturnPosition { section: number; page: number; fraction: number; find: string; textOffset?: number }
interface NavigationTarget { section: number; page: number; find: string; hash: string; fraction: number | null; returnTo?: ReturnPosition }
const typographyProperties = ["font-family", "font-size", "line-height", "text-align", "text-justify"] as const;
interface FrameState { frame: HTMLIFrameElement; section: number; ready: boolean; step?: number; scroller?: HTMLDivElement; pages?: HTMLDivElement; tail?: HTMLDivElement; style?: HTMLStyleElement; bookTypography?: { value: string; priority: string }[]; observer?: ResizeObserver; cleanup?: () => void; anchor?: Anchor; page: number }
export interface ReaderLocation { section: number; page: number; pageCount: number; frame: number }

/** Parent-owned DOM control. No EPUB script is executed or copied into the app. */
export class ReaderFrames {
  private frames: FrameState[];
  private active = -1;
  private desired: NavigationTarget;
  private returnHistory: ReturnPosition[] = [];
  private settings: ReaderSettings = defaultSettings;
  private disposed = false;
  private animation = 0;
  private searchText = "";
  private removeListeners: (() => void)[] = [];
  constructor(private data: ReaderFrameData, elements: HTMLIFrameElement[], position: { section: number; page: number; fraction?: number }, private change: (value: ReaderLocation) => void, private busy: (value: boolean) => void, private error: (value: string) => void, private interaction?: (kind: "toggle" | "activity" | "turn" | "tap") => boolean, private options: { columns?: 1 | 2; onReturnAvailableChange?: (available: boolean) => void } = {}) {
    this.desired = { ...position, fraction: position.fraction ?? null, find: "", hash: "" };
    this.frames = elements.map((frame, index) => ({ frame, section: index === 0 ? position.section : -1, ready: false, page: 1 }));
    this.frames.forEach((state, index) => {
      const load = () => this.loaded(index);
      state.frame.addEventListener("load", load);
      this.removeListeners.push(() => state.frame.removeEventListener("load", load));
    });
    const first = this.frames[0].frame;
    if (first.contentDocument?.readyState === "complete" && first.contentDocument.URL !== "about:blank") this.loaded(0);
  }
  configure(settings: ReaderSettings) {
    this.settings = settings;
    this.frames.forEach((state, index) => {
      if (!state.ready) return;
      const anchor = index === this.active ? this.capture(state) : undefined;
      this.layout(state);
      this.refresh(state, state.page, anchor);
    });
  }
  open(section: number, page = 1, find = "", hash = "", fraction: number | null = null) {
    this.navigate({ section, page, find, hash, fraction });
  }
  goBack() {
    const returnTo = this.returnHistory.at(-1);
    if (!returnTo || this.disposed) return false;
    this.navigate({ ...returnTo, hash: "", returnTo });
    return true;
  }
  clearReturnHistory() {
    this.returnHistory = [];
    this.options.onReturnAvailableChange?.(false);
  }
  private navigate(target: NavigationTarget) {
    const { section } = target;
    if (section < 0 || section >= this.data.sections.length || this.disposed) return;
    this.desired = target;
    this.busy(true); this.error("");
    const cached = this.frames.findIndex(state => state.section === section);
    if (cached >= 0) { if (this.frames[cached].ready) this.activate(cached); return; }
    const index = this.frames.findIndex((state, index) => index !== this.active && state.section !== this.currentSection() - 1);
    this.load(index >= 0 ? index : (this.active + 1) % this.frames.length, section);
  }
  turn(direction: -1 | 1) {
    if (this.active < 0 || this.busySection()) return;
    const state = this.frames[this.active], scroller = state.scroller!;
    const metrics = this.metrics(state);
    const left = Math.max(0, Math.min(metrics.maxLeft, scroller.scrollLeft + direction * metrics.step));
    if (Math.abs(left - scroller.scrollLeft) > pageEpsilon) { scroller.scrollTo({ left, top: 0, behavior: "auto" }); this.emit(state); }
    else this.open(state.section + direction, direction < 0 ? Number.MAX_SAFE_INTEGER : 1);
  }
  retry() { this.load(this.active < 0 ? 0 : (this.active + 1) % this.frames.length, this.desired.section); }
  key(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || target?.closest("input, textarea, select, button, a, [contenteditable]")) return;
    if (["ArrowLeft", "PageUp"].includes(event.key)) { event.preventDefault(); this.turn(-1); }
    if (["ArrowRight", "PageDown", " "].includes(event.key)) { event.preventDefault(); this.turn(1); }
  }
  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.animation);
    this.frames.forEach(state => { state.observer?.disconnect(); state.cleanup?.(); });
    this.removeListeners.forEach(remove => remove());
  }
  private currentSection() { return this.active >= 0 ? this.frames[this.active].section : this.desired.section; }
  private busySection() { return this.currentSection() !== this.desired.section; }
  private contentUrl(section: number) {
    return "html" in this.data ? "about:srcdoc" : contentUrl(this.data.book.book_id, this.data.sections[section].item_path);
  }
  private load(index: number, section: number) {
    const state = this.frames[index];
    state.observer?.disconnect(); state.cleanup?.(); state.cleanup = undefined;
    Object.assign(state, { section, ready: false, scroller: undefined, pages: undefined, anchor: undefined });
    // Setting src adds a joint-history entry per chapter, so Back would first step the hidden frame.
    if ("html" in this.data) { state.frame.srcdoc = this.data.html; return; }
    const url = this.contentUrl(section), window = state.frame.contentWindow;
    if (window && state.frame.getAttribute("src")) window.location.replace(new URL(url, document.baseURI).href);
    else state.frame.src = url;
  }
  private loaded(index: number) {
    if (this.disposed) return;
    const state = this.frames[index];
    if (state.section < 0 || state.ready) return;
    try {
      const doc = state.frame.contentDocument;
      const expected = new URL(this.contentUrl(state.section), window.location.href);
      if (!doc?.body || ("html" in this.data ? doc.URL !== "about:srcdoc" : new URL(doc.URL).pathname !== expected.pathname) || doc.contentType !== "text/html") throw new Error("章节加载失败，请重新登录或重试");
      const scroller = doc.createElement("div"), pages = doc.createElement("div"), tail = doc.createElement("div");
      scroller.id = "bindery-reader-scroller"; pages.id = "bindery-reader-pages"; tail.id = "bindery-reader-tail";
      tail.setAttribute("aria-hidden", "true");
      while (doc.body.firstChild) pages.appendChild(doc.body.firstChild);
      pages.appendChild(tail); scroller.appendChild(pages); doc.body.appendChild(scroller);
      const style = doc.createElement("style"); doc.head.appendChild(style);
      const bookTypography = typographyProperties.map(name => ({ value: doc.body.style.getPropertyValue(name), priority: doc.body.style.getPropertyPriority(name) }));
      Object.assign(state, { scroller, pages, tail, style, bookTypography, ready: true });
      this.layout(state);
      const scroll = () => { if (index === this.active) this.emit(state); };
      const key = (event: KeyboardEvent) => { if (this.interaction?.("turn") !== false) this.key(event); };
      const click = (event: MouseEvent) => {
        const anchor = (event.target as Element | null)?.closest("a");
        if (!anchor) return;
        event.preventDefault();
        if (index !== this.active || this.busySection()) return;
        const href = anchor.getAttribute("href");
        if (!href) return;
        const url = new URL(href, doc.baseURI);
        const section = this.data.sections.findIndex((_item, section) => new URL(this.contentUrl(section), window.location.href).pathname === url.pathname);
        if (url.origin === window.location.origin && section >= 0) {
          // Opted in by Reader only. Track all book links because older EPUBs
          // often omit epub:type/role on footnote references.
          if (this.options.onReturnAvailableChange) {
            const metrics = this.metrics(state);
            this.returnHistory.push({ section: state.section, page: metrics.page, fraction: metrics.count > 1 ? (metrics.page - 1) / (metrics.count - 1) : 0, find: this.searchText, textOffset: this.captureTextOffset(state) });
            if (this.returnHistory.length > 50) this.returnHistory.shift();
            this.options.onReturnAvailableChange(true);
          }
          this.open(section, 1, "", url.hash.slice(1));
        }
      };
      let pointer: { x: number; y: number } | undefined;
      const down = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; };
      const up = (event: PointerEvent) => {
        const start = pointer; pointer = undefined;
        if (!start || index !== this.active || !doc.getSelection()?.isCollapsed || (event.target as Element | null)?.closest("a,button,input,textarea,select,[contenteditable]")) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.hypot(dx, dy) <= 10 && this.interaction?.("tap") === false) return;
        if (!window.matchMedia("(max-width: 767px)").matches) return;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (this.interaction?.("turn") !== false) this.turn(dx < 0 ? 1 : -1);
        } else if (Math.hypot(dx, dy) <= 10) {
          if (event.clientX >= state.frame.clientWidth / 3 && event.clientX <= state.frame.clientWidth * 2 / 3) this.interaction?.("toggle");
          else if (this.interaction?.("turn") !== false) this.turn(event.clientX < state.frame.clientWidth / 3 ? -1 : 1);
        }
      };
      scroller.addEventListener("scroll", scroll, { passive: true });
      const move = (event: PointerEvent) => { if (index === this.active && event.pointerType !== "touch") this.interaction?.("activity"); };
      const cancel = () => { pointer = undefined; };
      doc.addEventListener("keydown", key); doc.addEventListener("click", click); doc.addEventListener("pointerdown", down); doc.addEventListener("pointerup", up); doc.addEventListener("pointermove", move); doc.addEventListener("pointercancel", cancel);
      state.cleanup = () => { scroller.removeEventListener("scroll", scroll); doc.removeEventListener("keydown", key); doc.removeEventListener("click", click); doc.removeEventListener("pointerdown", down); doc.removeEventListener("pointerup", up); doc.removeEventListener("pointermove", move); doc.removeEventListener("pointercancel", cancel); };
      state.observer = new ResizeObserver(() => {
        if (!state.ready || this.disposed) return;
        this.layout(state); this.refresh(state, state.page, state.anchor);
      });
      state.observer.observe(scroller);
      doc.fonts.ready.then(() => { if (!this.disposed && state.ready && state.scroller === scroller) this.refresh(state, state.page, state.anchor); });
      const images = Array.from(pages.querySelectorAll("img"));
      images.forEach(image => image.addEventListener("load", () => { if (!this.disposed && state.scroller === scroller) this.refresh(state, state.page, state.anchor); }, { once: true }));
      if (state.section === this.desired.section) this.activate(index);
    } catch (error) {
      if (state.section === this.desired.section) { this.busy(false); this.error(error instanceof Error ? error.message : "章节加载失败"); }
    }
  }
  private activate(index: number) {
    const state = this.frames[index];
    this.active = index; this.busy(false);
    this.frames.forEach((item, i) => { item.frame.inert = i !== index; });
    this.searchText = this.desired.find;
    this.highlight(state, this.searchText);
    const returnTo = this.desired.returnTo;
    const anchor = returnTo?.textOffset === undefined ? undefined : this.restoreTextOffset(state, returnTo.textOffset);
    if (anchor) this.desired.fraction = null;
    this.refresh(state, this.desired.page, anchor);
    if (returnTo) {
      // Keep the origin until restoration succeeds, including across a retry.
      if (this.returnHistory.at(-1) === returnTo) this.returnHistory.pop();
      this.desired.returnTo = undefined;
      this.options.onReturnAvailableChange?.(this.returnHistory.length > 0);
    } else if (this.desired.hash) {
      let id = this.desired.hash;
      try { id = decodeURIComponent(id); } catch { /* malformed fragment is ignored */ }
      const target = state.frame.contentDocument!.getElementById(id);
      if (target) this.locate(state, target.getBoundingClientRect().left);
    } else if (this.searchText) {
      const mark = state.pages!.querySelector("mark[data-reader-search]");
      if (mark) this.locate(state, mark.getBoundingClientRect().left);
    }
    this.emit(state);
    cancelAnimationFrame(this.animation);
    this.animation = requestAnimationFrame(() => {
      if (this.disposed) return;
      this.prefetch();
    });
  }
  private prefetch() {
    const section = this.currentSection();
    for (const adjacent of [section - 1, section + 1]) {
      if (adjacent < 0 || adjacent >= this.data.sections.length || this.frames.some(state => state.section === adjacent)) continue;
      const index = this.frames.findIndex((state, index) => index !== this.active && ![section - 1, section + 1].includes(state.section));
      if (index >= 0) this.load(index, adjacent);
    }
  }
  private layout(state: FrameState) {
    const value = this.settings, doc = state.frame.contentDocument!, vars = doc.documentElement.style;
    const x = value.styleMode === "custom" ? value.pagePaddingX : 0, y = value.styleMode === "custom" ? value.pagePaddingY : 0;
    // CSS custom properties do not cross iframe boundaries. Copy only trusted app tokens,
    // never book styles, into the isolated document before applying the existing settings.
    const tokens = window.getComputedStyle?.(state.frame);
    for (const token of ["--color-paper", "--color-paper-white", "--color-paper-dark", "--color-ink", "--color-surface", "--color-accent-soft", "--font-display", "--font-sans", "--font-mono"]) {
      const resolved = tokens?.getPropertyValue(token).trim();
      if (resolved) vars.setProperty(token, resolved);
    }
    const paper = readerPaper(value), bg = `var(--color-paper${paper === "paper" ? "" : `-${paper}`})`, color = `var(--color-${paper === "dark" ? "surface" : "ink"})`;
    const font = value.fontFamily === "kai" ? readerFonts.kai : `var(--font-${value.fontFamily === "serif" ? "display" : value.fontFamily}, ${readerFonts[value.fontFamily]})`;
    doc.documentElement.setAttribute("data-bindery-style", value.styleMode);
    // Book-original mode retains author boxes. Custom mode owns the page margins:
    // root padding must not silently narrow the columns or offset the spine.
    state.style!.textContent = `html,body{height:99%!important;background:var(--bindery-reader-bg)!important;}
      body{overflow:hidden!important;}
      #bindery-reader-scroller{position:relative!important;display:block!important;height:99%!important;width:100%!important;max-width:none!important;margin:0 auto!important;background:var(--bindery-reader-bg)!important;overflow-x:auto!important;overflow-y:hidden!important;direction:ltr!important;writing-mode:horizontal-tb!important;scroll-behavior:auto!important;scrollbar-width:none;overscroll-behavior-x:contain;}
      #bindery-reader-scroller::-webkit-scrollbar{display:none}
      #bindery-reader-pages{position:relative!important;display:block!important;float:none!important;clear:both!important;width:var(--bindery-page-step)!important;min-width:var(--bindery-page-step)!important;max-width:none!important;height:99%!important;box-sizing:border-box!important;column-fill:auto;column-width:var(--bindery-column-width);column-gap:var(--bindery-column-gap);padding-top:var(--bindery-page-padding-y)!important;padding-bottom:var(--bindery-page-padding-y)!important;padding-left:var(--bindery-page-padding-x)!important;padding-right:var(--bindery-page-padding-x)!important;margin:0!important;direction:ltr!important;writing-mode:horizontal-tb!important;}
      #bindery-reader-tail{position:absolute!important;display:block!important;left:calc(100% + var(--bindery-page-tail-offset,0px))!important;top:0!important;width:var(--bindery-page-tail-pad,0px)!important;min-width:var(--bindery-page-tail-pad,0px)!important;height:1px!important;pointer-events:none!important;opacity:0!important;}
      h1,h2,h3,h4,h5,h6,pre,blockquote,figure,table{break-inside:avoid-column;}
      img,svg,video{max-width:99%!important;height:auto!important;}
      mark[data-reader-search]{background:var(--color-accent-soft)!important;color:var(--color-ink)!important;}
      @media(max-width:767px){#bindery-reader-scroller{overflow-x:hidden!important;touch-action:pan-y!important;overscroll-behavior-x:none!important;}}
      ${value.styleMode === "custom" ? `html[data-bindery-style="custom"],html[data-bindery-style="custom"] body{margin:0!important;padding:0!important;border:0!important;width:auto!important;min-width:0!important;max-width:none!important;height:100%!important;box-sizing:border-box!important;}
      html[data-bindery-style="custom"] #bindery-reader-scroller,html[data-bindery-style="custom"] #bindery-reader-pages{height:100%!important;}
      html[data-bindery-style="custom"] body,html[data-bindery-style="custom"] #bindery-reader-pages,html[data-bindery-style="custom"] #bindery-reader-pages :is(p,li,div,span,b,strong,blockquote,td,th,h1,h2,h3,h4,h5,h6){font-family:var(--bindery-font-family)!important;font-size:var(--bindery-font-size)!important;line-height:var(--bindery-line-height,1.85)!important;text-align:var(--bindery-text-align,justify)!important;text-justify:var(--bindery-text-justify,inter-ideograph)!important;color:var(--bindery-reader-text)!important;}
      html[data-bindery-style="custom"] #bindery-reader-pages :is(h1,h2,h3,h4,h5,h6,span,b,strong){background-color:transparent!important;background-image:none!important;}
      html[data-bindery-style="custom"] #bindery-reader-pages p{margin:0!important;text-indent:2em!important;}
      html[data-bindery-style="custom"] #bindery-reader-pages p + p{margin-top:4px!important;}` : ""}`;
    vars.setProperty("--bindery-page-max-width", "1120px");
    // Like legacy, retain -1 in the variables: negative CSS padding computes to
    // its initial zero, while column sizing below uses nonnegative padding.
    vars.setProperty("--bindery-page-padding-x", `${x}px`);
    vars.setProperty("--bindery-page-padding-y", `${y}px`);
    vars.setProperty("--bindery-font-family", font);
    vars.setProperty("--bindery-font-size", `${value.fontSize}px`);
    vars.setProperty("--bindery-line-height", String(value.lineHeight));
    vars.setProperty("--bindery-reader-bg", bg);
    vars.setProperty("--bindery-reader-text", color);
    vars.setProperty("--bindery-text-align", value.textAlignMode);
    vars.setProperty("--bindery-text-justify", value.textAlignMode === "justify" ? "inter-ideograph" : "auto");
    const typography = [font, `${value.fontSize}px`, String(value.lineHeight), value.textAlignMode, value.textAlignMode === "justify" ? "inter-ideograph" : "auto"];
    typographyProperties.forEach((name, index) => {
      if (value.styleMode === "custom") {
        doc.body.style.setProperty(name, typography[index], "important");
        state.pages!.style.setProperty(name, typography[index], "important");
      } else {
        // legacy removes these inline properties when returning to book mode,
        // losing the book's original inline typography. Restore it instead.
        const original = state.bookTypography![index];
        if (original.value) doc.body.style.setProperty(name, original.value, original.priority);
        else doc.body.style.removeProperty(name);
        state.pages!.style.removeProperty(name);
      }
    });
    // Measure after applying the book box model and max-width. Percentage body
    // margins can leave fractional CSS pixels; pin pages to clientWidth so the
    // column pitch cannot drift from the integer scroll step over a long chapter.
    const width = Math.max(1, state.scroller!.clientWidth || state.frame.clientWidth);
    vars.setProperty("--bindery-page-step", `${width}px`);
    // One viewport is still one saved page/turn, now containing two columns on desktop.
    // The prototype spread keeps a wider gutter than the outer margin (40 outer / 72 inner at
    // the default). Keep that rhythm while the margin setting scales: gap = 2x + 64.
    const columns = this.options.columns ?? (window.matchMedia?.("(min-width: 768px)").matches ? 2 : 1);
    const gap = Math.max(0, x) * 2 + (columns === 2 ? 64 : 0);
    vars.setProperty("--bindery-column-width", `${Math.max(1, width / columns - Math.max(0, x) * 2 - (columns === 2 ? 32 : 0))}px`);
    vars.setProperty("--bindery-column-gap", `${gap}px`);
    // The wider spine adds 64px to the pitch of every pair of columns. Scrolling
    // only clientWidth would shift the next spread's text 64px to the right.
    state.step = width + (columns === 2 ? 64 : 0);
  }
  private metrics(state: FrameState) {
    const scroller = state.scroller!, step = state.step || Math.max(1, scroller.clientWidth);
    // Account for the offscreen inter-spread gap without adding a phantom last page.
    return pageMetrics(step, scroller.scrollWidth + step - scroller.clientWidth, scroller.scrollLeft);
  }
  private refresh(state: FrameState, desiredPage: number, anchor?: Anchor) {
    const scroller = state.scroller!, vars = state.frame.contentDocument!.documentElement.style;
    // Add only the fractional last-page remainder; tail lives inside the columns.
    vars.setProperty("--bindery-page-tail-pad", "0px"); vars.setProperty("--bindery-page-tail-offset", "0px");
    const rawMax = Math.max(0, scroller.scrollWidth - scroller.clientWidth), step = state.step || Math.max(1, scroller.clientWidth);
    const pad = (step - rawMax % step) % step;
    vars.setProperty("--bindery-page-tail-offset", `${rawMax}px`);
    vars.setProperty("--bindery-page-tail-pad", `${pad <= pageEpsilon || step - pad <= pageEpsilon ? 0 : pad}px`);
    const metrics = this.metrics(state);
    let page = Math.max(1, Math.min(metrics.count, desiredPage));
    if (anchor?.node.isConnected) {
      const range = anchor.node.ownerDocument.createRange(); range.setStart(anchor.node, Math.min(anchor.offset, anchor.node.length)); range.setEnd(anchor.node, Math.min(anchor.node.length, anchor.offset + 1));
      const rect = range.getBoundingClientRect();
      const left = scroller.scrollLeft + rect.left - scroller.getBoundingClientRect().left;
      page = Math.min(metrics.count, Math.max(1, Math.floor((left + pageEpsilon) / metrics.step) + 1));
    }
    if (this.frames[this.active] === state && this.desired.fraction !== null && state.section === this.desired.section) {
      page = fractionPage(this.desired.fraction, metrics.count);
      this.desired.fraction = null;
    }
    scroller.scrollTo({ left: Math.min(metrics.maxLeft, (page - 1) * metrics.step), top: 0, behavior: "auto" });
    state.page = page;
    if (this.frames[this.active] === state) this.emit(state);
  }
  private capture(state: FrameState): Anchor | undefined {
    const doc = state.frame.contentDocument!, rect = state.scroller!.getBoundingClientRect();
    const caretDoc = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const x = rect.left + Math.max(4, this.settings.pagePaddingX + 2), y = rect.top + Math.max(4, this.settings.pagePaddingY + 2);
    const position = caretDoc.caretPositionFromPoint?.(x, y), range = caretDoc.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode || range?.startContainer, offset = position?.offset ?? range?.startOffset ?? 0;
    if (node?.nodeType === 3 && state.pages!.contains(node)) return { node: node as Text, offset };
    const walker = doc.createTreeWalker(state.pages!, 4);
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (!text.data.trim() || text.parentElement?.closest("style,script")) continue;
      const textRange = doc.createRange(); textRange.selectNodeContents(text);
      if (Array.from(textRange.getClientRects()).some(r => r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom)) {
        let low = 0, high = text.length - 1;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          textRange.setStart(text, middle); textRange.setEnd(text, middle + 1);
          if (textRange.getBoundingClientRect().right <= rect.left + pageEpsilon) low = middle + 1;
          else high = middle;
        }
        return { node: text, offset: low };
      }
    }
  }
  // A character offset survives iframe eviction and search-highlight wrappers;
  // a live DOM Range alone would point into a discarded chapter after prefetch.
  private captureTextOffset(state: FrameState) {
    const anchor = this.capture(state);
    if (!anchor) return;
    const walker = state.frame.contentDocument!.createTreeWalker(state.pages!, 4);
    let offset = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === anchor.node) return offset + anchor.offset;
      offset += (walker.currentNode as Text).length;
    }
  }
  private restoreTextOffset(state: FrameState, offset: number): Anchor | undefined {
    const walker = state.frame.contentDocument!.createTreeWalker(state.pages!, 4);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (offset < node.length) return { node, offset };
      offset -= node.length;
    }
  }
  private emit(state: FrameState) {
    if (this.disposed || this.active < 0) return;
    const metrics = this.metrics(state);
    state.page = metrics.page; state.anchor = this.capture(state);
    this.change({ section: state.section, page: metrics.page, pageCount: metrics.count, frame: this.active });
  }
  private locate(state: FrameState, targetLeft: number) {
    const scroller = state.scroller!, left = scroller.scrollLeft + targetLeft - scroller.getBoundingClientRect().left;
    this.refresh(state, Math.floor((left + pageEpsilon) / this.metrics(state).step) + 1);
  }
  private highlight(state: FrameState, query: string) {
    const doc = state.frame.contentDocument!, root = state.pages!;
    root.querySelectorAll("mark[data-reader-search]").forEach(mark => mark.replaceWith(...Array.from(mark.childNodes)));
    root.normalize();
    if (!query.trim()) return;
    const nodes: Text[] = [], walker = doc.createTreeWalker(root, 4);
    while (walker.nextNode()) if (!(walker.currentNode.parentElement?.closest("style,script"))) nodes.push(walker.currentNode as Text);
    // Highlight text via DOM ranges, never interpolate search input into HTML.
    let remaining = 200;
    for (const node of nodes) {
      const matches = textMatches(node.data, query, remaining); remaining -= matches.length;
      for (const match of matches.reverse()) {
        const range = doc.createRange(); range.setStart(node, match.start); range.setEnd(node, match.end);
        const mark = doc.createElement("mark"); mark.dataset.readerSearch = ""; range.surroundContents(mark);
      }
    }
  }
}
