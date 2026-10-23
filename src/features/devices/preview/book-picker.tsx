import { createSignal, For } from "solid-js";
import { Select, TextField } from "../../../ui";
import type { PreviewBook } from "./model";

/** Book choice for the Kindle and Kobo previews: a search narrows the list; Enter opens the first match. */
export function PreviewBookPicker(props: { books: PreviewBook[]; value: string; disabled?: boolean; onChange: (id: string) => void }) {
  const [query, setQuery] = createSignal("");
  const label = (book: PreviewBook) => `${book.title}${book.author ? ` · ${book.author}` : ""}`;
  const matches = () => {
    const needle = query().trim().toLocaleLowerCase();
    return needle ? props.books.filter(book => label(book).toLocaleLowerCase().includes(needle)) : props.books;
  };
  // The current book stays listed so the select never shows a value it has no option for.
  const options = () => matches().some(book => book.id === props.value) ? matches() : [...props.books.filter(book => book.id === props.value), ...matches()];
  return <div class="kt-book-picker">
    <TextField class="search-field kt-book-search" label="搜索书籍" labelHidden type="search" placeholder="搜索书名或作者" value={query()} disabled={props.disabled}
      onInput={event => setQuery(event.currentTarget.value)}
      onKeyDown={event => { if (event.key !== "Enter") return; event.preventDefault(); const first = matches()[0]; if (first && first.id !== props.value) props.onChange(first.id); }} />
    <Select label={query().trim() ? `预览书籍（匹配 ${matches().length} 本）` : "预览书籍"} value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.currentTarget.value)}>
      <For each={options()}>{book => <option value={book.id}>{label(book)}</option>}</For>
    </Select>
  </div>;
}
