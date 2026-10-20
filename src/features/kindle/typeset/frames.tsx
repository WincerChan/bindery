import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { errorMessage } from "../../../client/kindle/fs";
import type { FontFamily, KindleModel, PairedDevice } from "../../../client/kindle";
import { DocumentFonts, PreviewDocument, previewTurnKey } from "./frame";
import { screenFor } from "./model";
import type { KindleMarginPreset } from "../../../client/kindle/margins";
import { Button } from "../../../ui";

export function ChapterFrame(props: { src: string; model: KindleModel; marginPreset: KindleMarginPreset; css: string | null; device: PairedDevice | null; family?: FontFamily; start: { page: number }; hasPrevious: boolean; hasNext: boolean; onChapter: (direction: -1 | 1) => void }) {
  let frame!: HTMLIFrameElement, screen!: HTMLDivElement, controller: PreviewDocument | undefined;
  let disposed = false, generation = 0;
  const [scale, setScale] = createSignal(0.4), [error, setError] = createSignal("");
  const dimensions = () => screenFor(props.model);
  const [loaded, setLoaded] = createSignal(0);
  const [position, setPosition] = createSignal({ page: 1, count: 1 }), [ready, setReady] = createSignal(false);
  const clear = () => { generation++; controller?.destroy(); controller = undefined; setError(""); setReady(false); setPosition({ page: 1, count: 1 }); };
  const turn = (direction: -1 | 1) => { controller?.turn(direction); };
  // Settings edits may recompute the prop without changing the chapter / asset mode.
  const source = createMemo(() => props.src);
  createEffect(source, clear);
  function onLoad() {
    clear();
    if (!props.src || disposed) return;
    try {
      const doc = frame.contentDocument;
      const expected = new URL(props.src, window.location.href);
      if (!doc?.body || doc.contentType !== "text/html" || new URL(doc.URL).pathname !== expected.pathname) throw new Error("章节加载失败，请确认登录状态并重新选择章节");
      controller = new PreviewDocument(doc, setPosition, direction => {
        if (direction < 0 ? props.hasPrevious : props.hasNext) props.onChapter(direction);
      }, props.start.page);
      setReady(true); setLoaded(value => value + 1);
    } catch (error) { setError(errorMessage(error)); }
  }
  createEffect(() => ({ css: props.css, device: props.device, family: props.family, model: props.model, marginPreset: props.marginPreset, loaded: loaded() }), value => {
    if (!controller) return;
    if (value.css !== null) controller.setDevice(value.model, value.marginPreset);
    const current = generation;
    void controller.update(value.css, value.device, value.family).catch(error => { if (!disposed && current === generation) setError(`设备字体加载失败：${errorMessage(error)}`); });
  });
  createEffect(() => props.start, start => { controller?.open(start.page); });
  onSettled(() => {
    const resize = () => { if (screen.clientWidth > 0) setScale(screen.clientWidth / dimensions().width); };
    const observer = new ResizeObserver(resize); observer.observe(screen); resize();
    // A chapter served in the SSR markup can finish loading before hydration installs onLoad.
    if (frame.contentDocument?.readyState === "complete" && frame.contentDocument.URL !== "about:blank") onLoad();
    return () => observer.disconnect();
  });
  // Model changes may keep the viewport width unchanged; resize the scale explicitly too.
  createEffect(() => dimensions().width, width => { if (screen?.clientWidth) setScale(screen.clientWidth / width); });
  onCleanup(() => { disposed = true; generation++; controller?.destroy(); controller = undefined; });
  return <div class="kt-frame-wrap">
    <div class="kt-device-bezel" style={{ "max-width": `${Math.round(640 * dimensions().width / dimensions().height) + 44}px` }}><div ref={screen} class="kt-screen" tabindex="0" role="group" aria-label="Kindle 分页预览，使用左右方向键或 PageUp、PageDown 翻页" onKeyDown={event => previewTurnKey(event, turn)} style={{ "aspect-ratio": `${dimensions().width} / ${dimensions().height}` }}>
      <iframe ref={frame} title="Kindle 章节排版预览" sandbox="allow-same-origin" referrerpolicy="no-referrer" src={props.src || undefined}
        width={dimensions().width} height={dimensions().height} style={{ transform: `scale(${scale()})` }} onLoad={onLoad} />
    </div></div>
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
    const lines = ["我可以吞下玻璃而不伤身体。", "The quick brown fox jumps over the lazy dog."].map(sample => {
      const line = doc.createElement("p");
      line.textContent = sample;
      line.style.cssText = 'margin:0; font:22px/1.5 "Bindery Device Sample"; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      return line;
    });
    doc.body.replaceChildren(...lines); doc.body.style.margin = "0";
    const fonts = new DocumentFonts(doc); registration = fonts;
    try { await fonts.load(props.device, props.family, "Bindery Device Sample"); }
    catch (error) { if (!disposed && registration === fonts) setError(errorMessage(error)); }
  }
  onSettled(() => { if (frame.contentDocument?.readyState === "complete") void load(); });
  onCleanup(() => { disposed = true; registration?.clear(); });
  return <div><iframe ref={frame} class="kt-font-sample" title={`${props.family.name} 字体样张`} sandbox="allow-same-origin" onLoad={load} />
    <Show when={error()}><span class="field-error">样张加载失败：{error()}</span></Show></div>;
}
