import TablerChevronLeft from "~icons/tabler/chevron-left";
import TablerChevronRight from "~icons/tabler/chevron-right";
import { createEffect, createSignal, Show } from "solid-js";
import { Icon, IconButton } from "../../ui";
import { ReaderFrames } from "./frame";
import "./preview.css";

/** Paginate a sanitized staged chapter without saving reading progress or changing its typography. */
export function ReaderPreview(props: { html: string; title: string }) {
  const [position, setPosition] = createSignal({ page: 1, pageCount: 1 });
  const [busy, setBusy] = createSignal(true), [error, setError] = createSignal("");
  let frame!: HTMLIFrameElement, reader: ReaderFrames | undefined;
  createEffect(() => props.html, html => {
    setBusy(true); setError(""); setPosition({ page: 1, pageCount: 1 });
    // Construct only after this srcdoc's load: an older document may still occupy the iframe.
    const load = () => {
      reader?.destroy();
      reader = new ReaderFrames({ html, sections: [{ title: props.title, item_path: "" }] }, [frame], { section: 0, page: 1 }, setPosition, setBusy, setError, undefined, { columns: 1 });
    };
    frame.addEventListener("load", load);
    frame.setAttribute("srcdoc", html);
    return () => { frame.removeEventListener("load", load); reader?.destroy(); reader = undefined; };
  });
  return <div class="reader-preview" aria-busy={busy() ? "true" : "false"}>
    <iframe ref={frame} title={props.title} sandbox="allow-same-origin" referrerpolicy="no-referrer" />
    <Show when={error()}><p class="reader-preview-error" role="alert">{error()}</p></Show>
    <nav class="reader-preview-controls" aria-label="预览翻页">
      <IconButton aria-label="预览上一页" title="上一页（← / PageUp）" disabled={busy() || position().page <= 1} onClick={() => reader?.turn(-1)}><Icon icon={TablerChevronLeft} /></IconButton>
      <span role="status">{position().page} / {position().pageCount}</span>
      <IconButton aria-label="预览下一页" title="下一页（→ / PageDown）" disabled={busy() || position().page >= position().pageCount} onClick={() => reader?.turn(1)}><Icon icon={TablerChevronRight} /></IconButton>
    </nav>
  </div>;
}
