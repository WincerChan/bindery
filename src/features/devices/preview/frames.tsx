import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { errorMessage } from "../../../client/kindle/fs";
import type { FontFamily, PairedDevice } from "../../../client/kindle";
import { DocumentFonts, PreviewDocument, previewTurnKey } from "./frame";
import type { PageGeometry } from "../../../client/devices/typeset";
import { Button } from "../../../ui";
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
    const wide = window.matchMedia("(min-width: 768px)");
    resizeFrame = () => {
      if (!viewport.clientWidth) return;
      const padding = window.getComputedStyle(bezel), { width, height } = dimensions();
      const horizontal = Number.parseFloat(padding.paddingLeft) + Number.parseFloat(padding.paddingRight);
      const vertical = Number.parseFloat(padding.paddingTop) + Number.parseFloat(padding.paddingBottom);
      const widthFit = Math.min((viewport.clientWidth - horizontal) / width, 640 / height);
      const heightFit = wide.matches ? (viewport.clientHeight - vertical) / height : Infinity;
      setScale(Math.max(0, Math.min(widthFit, heightFit)));
    };
    const resize = () => { resizeFrame(); };
    const observer = new ResizeObserver(resize); observer.observe(viewport);
    wide.addEventListener("change", resize); resize();
    // A chapter served in the SSR markup can finish loading before hydration installs onLoad.
    if (frame.contentDocument?.readyState === "complete" && frame.contentDocument.URL !== "about:blank") onLoad();
    else watchParsing();
    return () => { resizeFrame = () => {}; observer.disconnect(); wide.removeEventListener("change", resize); };
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
      <Button variant="secondary" disabled={!ready() || position().page === 1 && !props.hasPrevious} onClick={() => turn(-1)}>上一页</Button>
      <span role="status" aria-live="polite" aria-atomic="true" data-kindle-page-status>{ready() ? `第 ${position().page} / ${position().count} 页` : "正在分页…"}</span>
      <Button variant="secondary" disabled={!ready() || position().page === position().count && !props.hasNext} onClick={() => turn(1)}>下一页</Button>
    </div>
    <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show>
  </div>;
}

/** Samples live in blank, script-free frames; no device FontFace enters the app's FontFaceSet. */
export function FontSample(props: { device: PairedDevice; family: FontFamily }) {
  let frame!: HTMLIFrameElement, registration: DocumentFonts | undefined, sampleDocument: Document | undefined, disposed = false;
  const [error, setError] = createSignal("");
  async function load() {
    const doc = frame.contentDocument;
    if (!doc?.body || disposed || sampleDocument === doc) return;
    registration?.clear();
    sampleDocument = doc;
    const lines = ["永 书读百遍", "Aa Reading"].map(sample => {
      const line = doc.createElement("p");
      line.textContent = sample;
      line.style.cssText = 'margin:0; font:28px/1.5 "Bindery Device Sample"; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--sample-ink);';
      return line;
    });
    doc.body.replaceChildren(...lines); doc.body.style.margin = "0";
    doc.documentElement.style.setProperty("--sample-ink", getComputedStyle(frame).color);
    const fonts = new DocumentFonts(doc); registration = fonts;
    try { await fonts.load(props.device, props.family, "Bindery Device Sample"); }
    catch (error) { if (!disposed && registration === fonts) setError(errorMessage(error)); }
  }
  onSettled(() => { if (frame.contentDocument?.readyState === "complete") void load(); });
  onCleanup(() => { disposed = true; registration?.clear(); });
  return <div><iframe ref={frame} class="kt-font-sample" tabindex={-1} title={`${props.family.name} 字体样张`} sandbox="allow-same-origin" onLoad={load} />
    <Show when={error()}><span class="field-error">样张加载失败：{error()}</span></Show></div>;
}
