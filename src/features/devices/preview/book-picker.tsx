import { createEffect, createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { Icon } from "../../../ui";
import type { PreviewBook } from "./model";

const LIMIT = 100;
const label = (book: PreviewBook) => `${book.title}${book.author ? ` · ${book.author}` : ""}`;

/**
 * Book choice for the Kindle and Kobo previews as one searchable dropdown: open it, type to narrow the
 * list, Enter (or a click) picks the highlighted book; arrow keys move the highlight, Escape cancels.
 */
export function PreviewBookPicker(props: { books: PreviewBook[]; value: string; disabled?: boolean; pill?: boolean; onChange: (id: string) => void }) {
  const id = createUniqueId(), listId = `${id}-list`, optionId = (index: number) => `${id}-option-${index}`;
  const [open, setOpen] = createSignal(false), [query, setQuery] = createSignal(""), [active, setActive] = createSignal(0);
  let list: HTMLUListElement | undefined;
  const current = () => props.books.find(book => book.id === props.value);
  const matches = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    return needle ? props.books.filter(book => label(book).toLocaleLowerCase().includes(needle)) : props.books;
  });
  const shown = () => matches().slice(0, LIMIT);
  function show() {
    if (props.disabled || open()) return;
    setQuery(""); setOpen(true);
    setActive(Math.max(0, Math.min(LIMIT - 1, props.books.findIndex(book => book.id === props.value))));
  }
  function close() { setOpen(false); setQuery(""); }
  function choose(book: PreviewBook | undefined) {
    close();
    if (book && book.id !== props.value) props.onChange(book.id);
  }
  function move(step: number) {
    if (!open()) { show(); return; }
    const count = shown().length;
    if (count) setActive(index => (index + step + count) % count);
  }
  // Keep the highlighted option visible while moving through a long list.
  createEffect(() => open() && active(), index => {
    if (index === false || !list) return;
    (list.children[index] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  });
  return <div class={`field kt-book-picker ${props.pill ? "is-pill" : ""}`}>
    <label for={id} class={props.pill ? "sr-only" : undefined}>预览书籍</label>
    <div class="kt-combobox">
      <input id={id} type="text" role="combobox" autocomplete="off" spellcheck={false} disabled={props.disabled}
        aria-autocomplete="list" aria-expanded={open() ? "true" : "false"} aria-controls={listId}
        aria-activedescendant={open() && shown().length ? optionId(active()) : undefined}
        // While searching, the current book stays visible as the placeholder.
        placeholder={open() ? current() ? label(current()!) : "输入书名或作者筛选" : undefined}
        value={open() ? query() : current() ? props.pill ? current()!.title : label(current()!) : ""}
        onFocus={show} onClick={show} onBlur={close}
        onInput={event => { setQuery(event.currentTarget.value); setActive(0); if (!open()) setOpen(true); }}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
          else if (event.key === "Enter") { if (!open()) return; event.preventDefault(); choose(shown()[active()] ?? shown()[0]); }
          else if (event.key === "Escape" && open()) { event.preventDefault(); close(); }
        }} />
      <Show when={props.pill}><span class="kt-combobox-label" aria-hidden="true">书</span><span class="kt-combobox-chevron" aria-hidden="true"><Icon name="chevron-down" size={14} /></span></Show>
      <Show when={open()}>
        {/* mousedown would blur the input and close the list before the click lands. */}
        <ul ref={list} id={listId} role="listbox" aria-label="预览书籍" class="kt-combobox-list" onMouseDown={event => event.preventDefault()}>
          <For each={shown()} fallback={<li class="kt-combobox-note" role="presentation">没有匹配的书</li>}>{(book, index) =>
            <li id={optionId(index())} role="option" aria-selected={book.id === props.value ? "true" : "false"}
              class={index() === active() ? "is-active" : undefined}
              onMouseEnter={() => setActive(index())} onClick={() => choose(book)}>{label(book)}</li>}</For>
          <Show when={matches().length > LIMIT}><li class="kt-combobox-note" role="presentation">还有 {matches().length - LIMIT} 本，继续输入以缩小范围</li></Show>
        </ul>
      </Show>
    </div>
  </div>;
}
