import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { DeviceBook } from "../../client/devices/inventory";
import type { DeviceKind } from "../../client/devices/models";
import { defaultReadingSettings, pageGeometry, previewTarget } from "../../client/devices/typeset";
import { PreviewDocument } from "./preview/frame";
import { previewContentUrl } from "./preview/model";
import { EMPTY_SETTINGS } from "../../client/devices/profiles";

export interface DevicePageSample { bookId: string; title: string; chapter: string; path: string }
export type LoadDevicePageSample = (deviceId: string, bookId: string) => Promise<DevicePageSample | null>;
/** Non-interactive chapter sample; the surrounding real link is the sole focus target. */
export function ReadingPage(props: { deviceId: string; book: DeviceBook; kind: DeviceKind; model: string; revision?: string; load?: LoadDevicePageSample }) {
  const [sample, setSample] = createSignal<DevicePageSample | null>(null);
  let generation = 0, disposed = false, controller: PreviewDocument | undefined;
  const key = createMemo(() => `${props.deviceId}:${props.book.book_id ?? props.book.record?.book_id ?? ""}:${props.model}:${props.book.progress?.last_read_at ?? ""}:${props.revision ?? ""}`);
  createEffect(key, () => {
    const request = ++generation, bookId = props.book.book_id ?? props.book.record?.book_id;
    setSample(null); controller?.destroy(); controller = undefined;
    if (bookId && props.load) void props.load(props.deviceId, bookId).then(value => { if (!disposed && request === generation) setSample(value); }, () => {});
  });
  onCleanup(() => { disposed = true; generation++; controller?.destroy(); });
  const geometry = () => {
    const page = pageGeometry(previewTarget(props.kind, props.model), defaultReadingSettings(props.kind));
    // This small chapter sample is deliberately enlarged, not a miniature device
    // screenshot: keep its body at 12px on screen (design README §2.2).
    const emPx = Math.max(page.emPx, 12 * page.width / 160);
    return { ...page, emPx, baseEmPx: emPx, measured: false };
  }
  return <Show when={sample()} fallback={<p>{props.book.filename.split("/").at(-1)}<br />读到 {Math.round(props.book.progress?.percent ?? 0)}%<br />暂无可映射的章节样张</p>}>{value => <>
    <div class="device-page-sample" aria-hidden="true"><iframe title={`${value().title} · ${value().chapter}`} tabindex={-1} sandbox="allow-same-origin" src={previewContentUrl(value().bookId, value().path, EMPTY_SETTINGS)} width={geometry().width} height={geometry().height} style={{ transform: `scale(${160 / geometry().width})` }} onLoad={event => {
      const doc = event.currentTarget.contentDocument;
      if (disposed || !doc?.body || doc.contentType !== "text/html") return;
      // Never render a login redirect/error response as a reading page.
      if (new URL(doc.URL).pathname !== new URL(event.currentTarget.src).pathname) { setSample(null); return; }
      try {
        controller?.destroy(); controller = new PreviewDocument(doc, () => {}, () => {}, 1); controller.setGeometry(geometry()); void controller.update("", null).catch(() => {});
      } catch { controller?.destroy(); controller = undefined; setSample(null); }
    }} /></div><span class="sr-only">{value().title}，读到 {value().chapter}。展示该章节的放大排版样张，非真机截图。</span>
  </>}</Show>;
}
