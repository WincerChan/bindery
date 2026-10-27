import { createSignal, createUniqueId, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Dialog } from "../../ui";

/** Menu's shared item API only supports callbacks. This small adapter keeps real
 * links and POST forms (including no-JS access) while using the shared overlay,
 * focus management, keyboard navigation and responsive sheet presentation. */
export function LocalBookMenu(props: {
  title: string; author?: string | null; status?: string; failed?: boolean;
  children: (close: () => void) => JSX.Element;
}) {
  const [open, setOpen] = createSignal(false), [enhanced, setEnhanced] = createSignal(false), id = createUniqueId();
  onSettled(() => { setEnhanced(true); });
  let anchor!: HTMLButtonElement;
  return <div class="library-menu">
    <button ref={anchor} type="button" hidden={!enhanced()} class="ui-menu-trigger" aria-haspopup="menu" aria-expanded={open() ? "true" : "false"} aria-controls={id}
      onClick={() => setOpen(!open())} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>
      <span class="library-book-info"><span class="library-title">{props.title}</span><Show when={props.author}><span class="library-author">{props.author}</span></Show></span><span class="ui-menu-chevron" aria-hidden="true">⌄</span>
    </button>
    <Dialog id={id} title={props.title} subtitle={props.author || undefined} open={open()} onClose={() => setOpen(false)} variant="menu" anchor={() => anchor} class="library-book-menu">
      <Show when={props.status}><div role="status" class={`ui-menu-status ui-menu-status-${props.failed ? "danger" : "ok"}`}>{props.status}</div></Show>
      <div role="menu" aria-label={props.title}>{props.children(() => setOpen(false))}</div>
    </Dialog>
    <Show when={!enhanced()}><details class="library-native-actions"><summary>《{props.title}》的操作</summary><Show when={props.author}><p>{props.author}</p></Show><Show when={props.status}><p>{props.status}</p></Show>{props.children(() => {})}</details></Show>
  </div>;
}
