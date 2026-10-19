import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { errorMessage } from "../../../client/kindle/fs";
import type { FontFamily, KindleModel, PairedDevice } from "../../../client/kindle";
import { DocumentFonts, PreviewDocument } from "./frame";
import { screenFor } from "./model";

export function ChapterFrame(props: { src: string; model: KindleModel; css: string | null; device: PairedDevice | null; family?: FontFamily }) {
  let frame!: HTMLIFrameElement, screen!: HTMLDivElement, controller: PreviewDocument | undefined;
  let disposed = false, generation = 0;
  const [scale, setScale] = createSignal(0.4), [error, setError] = createSignal("");
  const dimensions = () => screenFor(props.model);
  const [loaded, setLoaded] = createSignal(0);
  const clear = () => { generation++; controller?.destroy(); controller = undefined; setError(""); };
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
      controller = new PreviewDocument(doc); setLoaded(value => value + 1);
    } catch (error) { setError(errorMessage(error)); }
  }
  createEffect(() => ({ css: props.css, device: props.device, family: props.family, loaded: loaded() }), value => {
    if (!controller) return;
    const current = generation;
    void controller.update(value.css, value.device, value.family).catch(error => { if (!disposed && current === generation) setError(`设备字体加载失败：${errorMessage(error)}`); });
  });
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
    <div class="kt-device-bezel" style={{ "max-width": `${Math.round(640 * dimensions().width / dimensions().height) + 44}px` }}><div ref={screen} class="kt-screen" style={{ "aspect-ratio": `${dimensions().width} / ${dimensions().height}` }}>
      <iframe ref={frame} title="Kindle 章节排版预览" sandbox="allow-same-origin" referrerpolicy="no-referrer" src={props.src || undefined}
        width={dimensions().width} height={dimensions().height} style={{ transform: `scale(${scale()})` }} onLoad={onLoad} />
    </div></div>
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
    const text = doc.createElement("p");
    text.textContent = "永和九年，岁在癸丑，暮春之初，会于会稽山阴之兰亭。";
    text.style.cssText = 'margin:0; font:22px/1.5 "Bindery Device Sample"; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    doc.body.replaceChildren(text); doc.body.style.margin = "0";
    const fonts = new DocumentFonts(doc); registration = fonts;
    try { await fonts.load(props.device, props.family, "Bindery Device Sample"); }
    catch (error) { if (!disposed && registration === fonts) setError(errorMessage(error)); }
  }
  onSettled(() => { if (frame.contentDocument?.readyState === "complete") void load(); });
  onCleanup(() => { disposed = true; registration?.clear(); });
  return <div><iframe ref={frame} class="kt-font-sample" title={`${props.family.name} 字体样张`} sandbox="allow-same-origin" onLoad={load} />
    <Show when={error()}><span class="field-error">样张加载失败：{error()}</span></Show></div>;
}
