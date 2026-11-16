import TablerArrowLeft from "~icons/tabler/arrow-left";
import TablerArrowRight from "~icons/tabler/arrow-right";
import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { errorMessage } from "../../../client/kindle/fs";
import type { FontFamily, PairedDevice } from "../../../client/kindle";
import { DocumentFonts, PreviewDocument, previewTurnKey, sampleFonts, sampleRuns } from "./frame";
import type { PageGeometry } from "../../../client/devices/typeset";
import { Button, Icon } from "../../../ui";
import { hasSideGrip } from "../device-shell";

/** A page whose column pitch is twice the screen width, so sideways overflow never leaks into the next page. */
export function ChapterFrame(props: { src: string; geometry: PageGeometry; kind?: "kindle" | "kobo"; model?: string; label?: string; css: string | null; device: PairedDevice | null; family?: FontFamily; start: { page: number }; hasPrevious: boolean; hasNext: boolean; onChapter: (direction: -1 | 1) => void }) {
  let frame!: HTMLIFrameElement, viewport!: HTMLDivElement, bezel!: HTMLDivElement, controller: PreviewDocument | undefined;
  let resizeFrame = () => {};
  let disposed = false, generation = 0;
  const [scale, setScale] = createSignal(0.4), [error, setError] = createSignal("");
  const dimensions = () => props.geometry, label = () => props.label ?? "设备";
  const [loaded, setLoaded] = createSignal(0);
  const [position, setPosition] = createSignal({ page: 1, count: 1 }), [ready, setReady] = createSignal(false);
  let controlled: Document | null = null, loadedGeneration = -1;
  const clear = () => { generation++; controller?.destroy(); controller = undefined; controlled = null; setError(""); setReady(false); setPosition({ page: 1, count: 1 }); };
  const turn = (direction: -1 | 1) => { controller?.turn(direction); };
  /**
   * Takes over the chapter as soon as it is parsed, not at `load`, which waits for every font and image:
   * until then the frame would show the raw document at the browser's 16px. The controller re-paginates
   * when those resources arrive. `final` (the load event) turns a document that never matched into an error.
   */
  function attach(final: boolean): boolean {
    if (!props.src || disposed) return true;
    const doc = frame.contentDocument;
    if (doc && doc === controlled) return true;
    const expected = new URL(props.src, window.location.href);
    const parsed = doc && doc.URL !== "about:blank" && doc.readyState !== "loading" && new URL(doc.URL).pathname === expected.pathname;
    if (!parsed) {
      if (final) setError("章节加载失败，请确认登录状态并重新选择章节");
      return false;
    }
    try {
      if (!doc.body || doc.contentType !== "text/html") throw new Error("章节加载失败，请确认登录状态并重新选择章节");
      controller?.destroy(); controlled = doc;
      controller = new PreviewDocument(doc, setPosition, direction => {
        if (direction < 0 ? props.hasPrevious : props.hasNext) props.onChapter(direction);
      }, props.start.page);
      setReady(true); setLoaded(value => value + 1);
    } catch (error) { setError(errorMessage(error)); }
    return true;
  }
  function watchParsing() {
    const current = generation, later = (next: () => void) => typeof requestAnimationFrame === "function" ? requestAnimationFrame(next) : setTimeout(next, 16);
    // The load event settles the attempt (attached or an error), so polling stops there at the latest.
    const tick = () => { if (current === generation && loadedGeneration !== generation && !disposed && !attach(false)) later(tick); };
    later(tick);
  }
  // Settings edits may recompute the prop without changing the chapter / asset mode.
  const source = createMemo(() => props.src);
  createEffect(source, () => { clear(); if (typeof window !== "undefined") watchParsing(); });
  function onLoad() { loadedGeneration = generation; attach(true); }
  createEffect(() => ({ css: props.css, device: props.device, family: props.family, geometry: props.geometry, loaded: loaded() }), value => {
    if (!controller) return;
    controller.setGeometry(value.geometry);
    const current = generation;
    void controller.update(value.css, value.device, value.family).catch(error => { if (!disposed && current === generation) setError(`设备字体加载失败：${errorMessage(error)}`); });
  });
  createEffect(() => props.start, start => { controller?.open(start.page); });
  onSettled(() => {
    resizeFrame = () => {
      if (!viewport.clientWidth) return;
      const padding = window.getComputedStyle(bezel), { width, height } = dimensions();
      const horizontal = Number.parseFloat(padding.paddingLeft) + Number.parseFloat(padding.paddingRight);
      // The figure now has content-driven height. Fitting to clientHeight feeds the
      // previous model's size back into the next one and progressively shrinks it.
      const widthFit = Math.min((viewport.clientWidth - horizontal) / width, 640 / height);
      setScale(Math.max(0, widthFit));
    };
    const resize = () => { resizeFrame(); };
    const observer = new ResizeObserver(resize); observer.observe(viewport);
    resize();
    // A chapter served in the SSR markup can finish loading before hydration installs onLoad.
    if (frame.contentDocument?.readyState === "complete" && frame.contentDocument.URL !== "about:blank") onLoad();
    else watchParsing();
    return () => { resizeFrame = () => {}; observer.disconnect(); };
  });
  // Model changes may leave both available dimensions unchanged.
  createEffect(dimensions, () => { resizeFrame(); });
  onCleanup(() => { disposed = true; generation++; controller?.destroy(); controller = undefined; });
  return <div class="kt-frame-wrap">
    <div ref={viewport} class="kt-device-space"><div ref={bezel} class={`kt-device-bezel ${hasSideGrip(props.kind ?? "kindle", props.model ?? "KPW3") ? "device-shell-grip" : ""}`} style={{ width: `${dimensions().width * scale()}px` }}><div class="kt-screen" tabindex="0" role="group" aria-label={`${label()} 分页预览，使用左右方向键或 PageUp、PageDown 翻页`} onKeyDown={event => previewTurnKey(event, turn)} style={{ "aspect-ratio": `${dimensions().width} / ${dimensions().height}` }}>
      <iframe ref={frame} title={`${label()} 章节排版预览`} sandbox="allow-same-origin" referrerpolicy="no-referrer" src={props.src || undefined}
        width={dimensions().width} height={dimensions().height} style={{ transform: `scale(${scale()})`, visibility: ready() ? "visible" : "hidden" }} onLoad={onLoad} />
    </div></div></div>
    <div class="kt-actions kt-page-controls" role="group" aria-label="预览翻页">
      <Button class="kt-page-turn" variant="secondary" aria-label="上一页" title="上一页" disabled={!ready() || position().page === 1 && !props.hasPrevious} onClick={() => turn(-1)}><Icon icon={TablerArrowLeft} size={18} /></Button>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-kindle-page-status>{ready() ? `第 ${position().page} / ${position().count} 页` : "正在分页…"}</span>
      <Show when={ready()}><span class="kt-page-number" aria-hidden="true"><b>{String(position().page).padStart(2, "0")}</b><span>/ {position().count} 页</span></span></Show>
      <Button class="kt-page-turn" variant="secondary" aria-label="下一页" title="下一页" disabled={!ready() || position().page === position().count && !props.hasNext} onClick={() => turn(1)}><Icon icon={TablerArrowRight} size={18} /></Button>
    </div>
    <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show>
  </div>;
}

// Device fonts can be tens of megabytes each; a page of samples loads them a couple at a time.
const SAMPLE_LOADS = 2;
const sampleSlots = { active: 0, waiting: [] as (() => void)[] };
async function withSampleSlot<T>(run: () => Promise<T>): Promise<T> {
  if (sampleSlots.active >= SAMPLE_LOADS) await new Promise<void>(resolve => sampleSlots.waiting.push(resolve));
  sampleSlots.active++;
  try { return await run(); }
  finally { sampleSlots.active--; sampleSlots.waiting.shift()?.(); }
}

/** Samples live in blank, script-free frames; no device FontFace enters the app's FontFaceSet. */
export function FontSample(props: { device: PairedDevice; family: FontFamily; text?: string }) {
  let frame!: HTMLIFrameElement, registration: DocumentFonts | undefined, sampleDocument: Document | undefined, phrase: HTMLSpanElement | undefined, disposed = false;
  const [error, setError] = createSignal(""), [characters, setCharacters] = createSignal<((code: number) => boolean) | null>(null);
  const cjk = () => props.family.fonts.some(font => font.cjk);
  // The large glyph stays; the reader's text replaces only the phrase beside it.
  function paint() {
    if (!phrase) return;
    const custom = props.text?.trim() ? props.text : "", doc = phrase.ownerDocument;
    phrase.style.cssText = `font-size:30px; line-height:1; ${custom ? "" : cjk() ? "font-weight:500;" : "font-style:italic;"}`;
    // Characters the font lacks would silently render in a fallback face; mark them instead.
    phrase.replaceChildren(...sampleRuns(custom || (cjk() ? "书读百遍" : "Reading"), characters()).map(run => {
      if (!run.missing) return doc.createTextNode(run.text);
      const gap = doc.createElement("span");
      gap.textContent = run.text;
      gap.style.cssText = "color:var(--sample-missing); text-decoration:underline dashed; text-underline-offset:6px;";
      return gap;
    }));
  }
  // The frame's text appears at once; its font loads only once the sample is near the viewport.
  let visible = typeof IntersectionObserver === "undefined", observer: IntersectionObserver | undefined, fontDocument: Document | undefined;
  function load() {
    const doc = frame.contentDocument;
    if (!doc?.body || disposed || sampleDocument === doc) return;
    registration?.clear();
    sampleDocument = doc; setCharacters(null);
    const line = doc.createElement("p");
    line.style.cssText = 'margin:0; display:flex; align-items:baseline; gap:18px; white-space:nowrap; overflow:hidden; color:var(--sample-ink); font-family:"Bindery Device Sample", serif;';
    const specimen = doc.createElement("span");
    specimen.textContent = cjk() ? "永" : "Aa";
    specimen.style.cssText = 'flex:none; font-size:72px; line-height:1;';
    phrase = doc.createElement("span");
    phrase.style.cssText = "min-width:0; overflow:hidden; text-overflow:ellipsis;";
    line.append(specimen, phrase);
    doc.body.replaceChildren(line); doc.body.style.margin = "0";
    const style = getComputedStyle(frame);
    doc.documentElement.style.setProperty("--sample-ink", style.color);
    doc.documentElement.style.setProperty("--sample-missing", style.getPropertyValue("--color-ink-4") || style.color);
    paint();
    void loadFont();
  }
  async function loadFont() {
    const doc = sampleDocument;
    if (!doc || disposed || !visible || fontDocument === doc) return;
    fontDocument = doc;
    const fonts = new DocumentFonts(doc); registration = fonts;
    try {
      const map = await withSampleSlot(() => disposed || registration !== fonts ? Promise.resolve(null)
        : fonts.load(props.device, props.family, "Bindery Device Sample", { fonts: sampleFonts(props.family), characters: true }));
      if (!disposed && registration === fonts) setCharacters(() => map);
    } catch (error) { if (!disposed && registration === fonts) setError(errorMessage(error)); }
  }
  createEffect(() => [props.text, characters()] as const, () => { paint(); });
  onSettled(() => {
    if (!visible) {
      observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        visible = true; observer?.disconnect(); void loadFont();
      }, { rootMargin: "200px" });
      observer.observe(frame);
    }
    if (frame.contentDocument?.readyState === "complete") load();
  });
  onCleanup(() => { disposed = true; observer?.disconnect(); registration?.clear(); });
  return <div><iframe ref={frame} class="kt-font-sample" tabindex={-1} title={`${props.family.name} 字体样张`} sandbox="allow-same-origin" onLoad={load} />
    <Show when={error()}><span class="field-error">样张加载失败：{error()}</span></Show></div>;
}
