import { createEffect, createSignal, For, Show } from "solid-js";
import { Button, Checkbox, ConfirmDialog, EmptyState, GeneratedCover } from "../../ui";
import type { BookView } from "../../server/book-view";
import { showToast } from "../../client/toast";
import { SelectedIds } from "./library-page";

export function ArchivePage(props: { books: BookView[]; restore: (ids: string[]) => Promise<unknown>; refresh: () => Promise<unknown> }) {
  const [selected, setSelected] = createSignal<string[]>([]), [deleteForm, setDeleteForm] = createSignal<HTMLFormElement | null>(null), [busy, setBusy] = createSignal(false);
  createEffect(() => props.books.map(book => book.book_id), ids => { setSelected(current => current.filter(id => ids.includes(id))); });
  const toggle = (id: string) => setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  async function restore() {
    setBusy(true);
    try { await props.restore(selected()); setSelected([]); await props.refresh(); showToast("已恢复书籍"); }
    catch (error) { showToast(error instanceof Error ? error.message : "恢复失败，请重试", "error"); }
    finally { setBusy(false); }
  }
  function confirmDelete(event: SubmitEvent) { event.preventDefault(); setDeleteForm(event.currentTarget as HTMLFormElement); }
  return <div class="library-page library-archive">
    <div class="library-heading"><h1>归档</h1><span>{props.books.length} 册</span><Show when={props.books.length}><Button data-archive-select-all variant="secondary" onClick={() => setSelected(props.books.map(book => book.book_id))}>全选本页</Button></Show></div>
    <Show when={props.books.length} fallback={<EmptyState title="归档为空。" />}>
      <div class="library-bulk" data-archive-bulk-bar role="toolbar" aria-label="归档批量操作" hidden={!selected().length}>
        <span aria-live="polite">已选 {selected().length} 册</span><Button variant="quiet" data-archive-clear onClick={() => setSelected([])}>清空</Button>
        <Button variant="secondary" disabled={busy() || !selected().length} onClick={restore}>{busy() ? "处理中…" : "批量恢复"}</Button>
        <form id="archive-bulk-delete-form" action="/archive/delete-bulk" method="post" onSubmit={confirmDelete}><div data-archive-book-ids><SelectedIds ids={selected()} /></div><Button type="submit" variant="danger" data-archive-bulk-delete disabled={busy() || !selected().length}>批量删除</Button></form>
      </div>
      <div class="library-archive-head" aria-hidden="true"><span>书名 / 作者</span><span>出版</span><span>格式</span><span>更新</span><span>操作</span></div>
      <For each={props.books}>{book => <article class={`library-archive-row ${selected().includes(book.book_id) ? "is-selected" : ""}`}>
        <div class="library-selection"><Checkbox data-archive-select label={`选择《${book.title}》`} checked={selected().includes(book.book_id)} value={book.book_id} onChange={() => toggle(book.book_id)} /></div>
        <div class="library-archive-cover"><GeneratedCover {...book} compact /></div>
        <div class="library-book-info"><h2 class="library-title" title={book.title}>{book.title}</h2><p class="library-author">{book.author || "未知"}</p><p class="library-phone-meta">{book.source_type.toUpperCase()} · {book.updated_at.slice(0, 10)}</p></div>
        <span class="library-publisher">{book.publisher || "—"}{book.published ? ` · ${book.published.slice(0, 4)}` : ""}</span><span class="library-format">{book.source_type.toUpperCase()}</span><time class="library-updated" datetime={book.updated_at || undefined}>{book.updated_at.slice(0, 10) || "—"}</time>
        <div class="library-archive-actions"><form action={`/book/${book.book_id}/restore`} method="post"><Button type="submit" variant="secondary" size="sm">恢复</Button></form><form action={`/book/${book.book_id}/delete`} method="post" onSubmit={confirmDelete}><Button type="submit" variant="danger" size="sm">彻底删除</Button></form></div>
      </article>}</For>
    </Show>
    <ConfirmDialog open={Boolean(deleteForm())} title="永久删除书籍" danger confirmLabel="彻底删除" onClose={() => setDeleteForm(null)} onConfirm={() => deleteForm()?.submit()}>确定永久删除？书籍文件删除后无法恢复。</ConfirmDialog>
  </div>;
}
