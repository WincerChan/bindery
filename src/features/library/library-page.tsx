import { createEffect, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { BookCover, Button, Checkbox, Chip, ConfirmDialog, EmptyState, Pagination, Select, Tag, TextField } from "../../ui";
import { showToast } from "../../client/toast";
import { withToast } from "../../shared/notifications";
import type { BookView } from "../../server/book-view";
import type { LibraryPageData } from "../../server/library/queries";
import { bookHref, gridPageSize, libraryReturnTo, type LibrarySearch } from "./search";

type View = "grid" | "list";
export function LibraryBook(props: { book: BookView; returnTo: string; view: View; selecting: boolean; selected: boolean; toggle: () => void; confirmArchive?: (form: HTMLFormElement) => void }) {
  const book = () => props.book;
  return <article class={`library-book ${props.selected ? "is-selected" : ""}`} data-book-card data-book-id={book().book_id} data-book-layout={props.view}>
    <div class="library-selection" data-book-select-wrap hidden={!props.selecting}>
      <Checkbox data-book-select label={`选择《${book().title}》`} value={book().book_id} checked={props.selected} onChange={props.toggle} />
    </div>
    <div class="library-cover">
      <BookCover {...book()} compact={props.view === "list"} />
      <Show when={props.selecting} fallback={<>
        <a class="library-cover-link" data-book-detail-link href={bookHref(book().book_id, props.returnTo)} aria-label={`打开《${book().title}》详情`} />
        <a class="library-hover-read" data-book-hover-actions href={bookHref(book().book_id, props.returnTo, true)}>阅读</a>
      </>}><button type="button" class="library-cover-link" aria-label={`选择《${book().title}》`} aria-pressed={props.selected ? "true" : "false"} onClick={props.toggle} /></Show>
    </div>
    <div class="library-book-info">
      <Show when={props.selecting} fallback={<a class="library-title" data-book-detail-link href={bookHref(book().book_id, props.returnTo)} title={book().title}>{book().title}</a>}>
        <button type="button" class="library-title library-select-title" aria-pressed={props.selected ? "true" : "false"} onClick={props.toggle}>{book().title}</button>
      </Show>
      <p class="library-author">{book().author || "未知"}</p>
      <div class="library-marks"><Show when={book().read}><span class="library-read-mark">✓ 已读</span></Show><Show when={book().status_class !== "ok"}><Tag tone={book().status_class}>{book().status_label}</Tag></Show></div>
      <p class="library-phone-meta">{book().source_type.toUpperCase()}{book().updated_at ? ` · ${book().updated_at.slice(5, 10)}` : ""}</p>
    </div>
    <div class="library-publisher">{book().publisher || "—"}{book().published ? ` · ${book().published!.slice(0, 4)}` : ""}</div>
    <span class="library-format">{book().source_type.toUpperCase()}</span>
    <time class="library-updated" datetime={book().updated_at || undefined}>{book().updated_at.slice(0, 10) || "—"}</time>
    <div class="library-book-actions" hidden={props.selecting}>
      <a class="btn btn-secondary btn-sm" href={bookHref(book().book_id, props.returnTo, true)}>阅读</a>
      <a class="btn btn-quiet btn-sm library-desktop-action" href={`/book/${book().book_id}/download`}>下载</a>
      <form class="library-desktop-action" action={`/book/${book().book_id}/archive`} method="post" onSubmit={event => {
        if (props.confirmArchive) { event.preventDefault(); props.confirmArchive(event.currentTarget); }
      }}><input type="hidden" name="next" value={props.returnTo} /><Button type="submit" variant="quiet" size="sm">归档</Button></form>
    </div>
  </article>;
}

export function LibrarySection(props: { data: LibraryPageData; view?: View; selecting?: boolean; selected?: string[]; toggle?: (id: string) => void; confirmArchive?: (form: HTMLFormElement) => void }) {
  return <div id="library-section" data-page={props.data.page} data-total-books={props.data.total_books}>
    <div id="library" class={`library-collection ${props.selecting ? "is-selecting" : ""}`} data-view={props.view || "grid"}>
      <Show when={props.data.books.length} fallback={<EmptyState title="书库还是空的" action={<a href="/ingest" class="btn btn-primary">入库第一本书</a>}>上传 TXT 或 EPUB，开始整理你的书库。</EmptyState>}>
        <div class="library-list-head" data-library-list-head aria-hidden="true"><span>书名 / 作者</span><span>出版</span><span>格式</span><span>更新</span><span>操作</span></div>
        <For each={props.data.books}>{book => <LibraryBook book={book} returnTo={props.data.return_to} view={props.view || "grid"} selecting={Boolean(props.selecting)} selected={Boolean(props.selected?.includes(book.book_id))} toggle={() => props.toggle?.(book.book_id)} confirmArchive={props.confirmArchive} />}</For>
      </Show>
    </div>
    <div class="library-pager"><span>{props.data.total_books ? (props.data.page - 1) * props.data.per_page + 1 : 0}–{(props.data.page - 1) * props.data.per_page + props.data.books.length} / {props.data.total_books}</span><span aria-label={`第 ${props.data.page} / ${props.data.total_pages} 页`}>{props.data.page} / {props.data.total_pages}</span></div>
    <Pagination page={props.data.page} perPage={props.data.per_page} total={props.data.total_books} href={props.data.return_to} />
  </div>;
}

export function SelectedIds(props: { ids: string[] }) {
  return <div data-book-ids><For each={props.ids}>{id => <input type="hidden" name="book_ids" value={id} />}</For></div>;
}

export function LibraryPage(props: {
  data: LibraryPageData; initialView?: View;
  onSearch?: (search: LibrarySearch) => unknown | Promise<unknown>;
  regenerate: (ids: string[]) => Promise<{ queued: number; failed: number; skipped: number }>;
}) {
  const [view, setView] = createSignal<View>(untrack(() => props.initialView || "grid")), [selecting, setSelecting] = createSignal(false), [selected, setSelected] = createSignal<string[]>([]);
  const [query, setQuery] = createSignal(untrack(() => props.data.q)), [busy, setBusy] = createSignal(false), [archiveForm, setArchiveForm] = createSignal<HTMLFormElement | null>(null);
  let page!: HTMLDivElement, timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => props.data.q, q => { setQuery(q); });
  createEffect(() => props.data.books.map(book => book.book_id), ids => { setSelected(current => current.filter(id => ids.includes(id))); });
  onCleanup(() => clearTimeout(timer));
  async function search(overrides: Partial<LibrarySearch>) {
    clearTimeout(timer);
    const value = { sort: props.data.sort, q: query(), read_filter: props.data.read_filter, per_page: props.data.per_page, page: 1, ...overrides };
    try { if (props.onSearch) await props.onSearch(value); else window.location.assign(libraryReturnTo(value)); }
    catch (error) { showToast(error instanceof Error ? error.message : "加载失败，请重试", "error"); }
  }
  onSettled(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 767px)");
    const saved = () => { try { return localStorage.getItem("bindery-view") === "list" ? "list" : "grid"; } catch { return "grid"; } };
    const syncView = () => setView(media.matches ? "list" : saved());
    syncView(); media.addEventListener("change", syncView);
    let widthTimer: ReturnType<typeof setTimeout> | undefined;
    const syncSize = () => {
      clearTimeout(widthTimer);
      widthTimer = setTimeout(() => {
        if (media.matches || view() !== "grid") return;
        const width = page.querySelector<HTMLElement>("#library")?.clientWidth || 0;
        const per_page = gridPageSize(width);
        if (width && per_page !== props.data.per_page) void search({ per_page });
      }, 150);
    };
    const observer = new ResizeObserver(syncSize); observer.observe(page);
    return () => { media.removeEventListener("change", syncView); observer.disconnect(); clearTimeout(widthTimer); };
  });
  function changeView(next: View) {
    setView(next);
    try { localStorage.setItem("bindery-view", next); } catch { /* View still works when storage is disabled. */ }
    if (next === "grid") { const width = page.querySelector<HTMLElement>("#library")?.clientWidth || 0; if (width) void search({ per_page: gridPageSize(width) }); }
  }
  const toggle = (id: string) => setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  function done() { setSelecting(false); setSelected([]); }
  async function regenerate() {
    setBusy(true);
    try {
      const result = await props.regenerate(selected());
      if (!result.queued) { showToast(result.failed ? "任务队列已满，请稍后重试" : "没有匹配的书籍可批量处理", "error"); return; }
      window.location.assign(withToast("/jobs?tab=running", `已创建 ${result.queued} 个任务${result.failed ? `，${result.failed} 个任务入队失败` : ""}`, result.failed ? "warning" : "success"));
    } catch (error) { showToast(error instanceof Error ? error.message : "创建任务失败", "error"); }
    finally { setBusy(false); }
  }
  async function download(event: SubmitEvent) {
    event.preventDefault(); setBusy(true);
    const form = event.currentTarget as HTMLFormElement;
    try {
      const response = await fetch(form.action, { method: "POST", body: new FormData(form) });
      if (response.redirected && new URL(response.url).pathname === "/login") { window.location.assign(response.url); return; }
      if (!response.ok) { const data = await response.json(); throw new Error(data.detail || "下载失败"); }
      const blob = await response.blob(), url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "")?.[1] || "bindery-books.zip";
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { showToast(error instanceof Error ? error.message : "下载失败，请重试", "error"); }
    finally { setBusy(false); }
  }
  return <div class="library-page" ref={page}>
    <div class="library-heading"><h1>书库</h1><span data-library-count>{props.data.total_books} 册{props.data.read_filter === "unread" ? " · 仅未读" : ""}</span><a href="/ingest" class="btn btn-primary">+ 入库</a></div>
    <form id="library-controls" class="library-controls" action="/" method="get" onSubmit={event => { event.preventDefault(); void search({}); }}>
      <TextField class="library-search" label="搜索" type="search" name="q" placeholder="搜索书名、作者" value={query()} onInput={event => { setQuery(event.currentTarget.value); clearTimeout(timer); timer = setTimeout(() => void search({}), 400); }} />
      <Select label="排序" name="sort" value={props.data.sort} onChange={event => void search({ sort: event.currentTarget.value === "created" ? "created" : "updated" })}><option value="created">最近导入</option><option value="updated">最近修改</option></Select>
      <input type="hidden" name="read_filter" value={props.data.read_filter} /><input type="hidden" name="page" value="1" data-page-input /><input type="hidden" name="per_page" value={props.data.per_page} data-per-page-input />
      <Button type="submit" variant="secondary">搜索</Button>
      <Chip data-read-filter-toggle selected={props.data.read_filter === "unread"} onClick={() => void search({ read_filter: props.data.read_filter === "unread" ? "all" : "unread" })}>仅看未读{props.data.read_filter === "unread" ? " ×" : ""}</Chip>
      <div class="library-view-toggle" role="group" aria-label="显示方式"><Chip selected={view() === "grid"} onClick={() => changeView("grid")}>封面墙</Chip><Chip selected={view() === "list"} onClick={() => changeView("list")}>列表</Chip></div>
      <Chip data-bulk-mode-toggle selected={selecting()} onClick={() => selecting() ? done() : setSelecting(true)}>多选</Chip>
    </form>
    <div data-bulk-controls><div class="library-bulk" data-bulk-actions role="toolbar" aria-label="批量操作" hidden={!selecting()}>
      <span aria-live="polite">已选 <strong data-selected-count>{selected().length}</strong> 册</span>
      <Checkbox data-bulk-select-all label="全选本页" checked={Boolean(props.data.books.length) && selected().length === props.data.books.length} indeterminate={selected().length > 0 && selected().length < props.data.books.length} onChange={event => setSelected(event.currentTarget.checked ? props.data.books.map(book => book.book_id) : [])} />
      <Button data-bulk-clear variant="quiet" onClick={() => setSelected([])}>清空</Button><Button data-bulk-done variant="secondary" onClick={done}>完成</Button>
      <form action="/books/download" method="post" onSubmit={download}><SelectedIds ids={selected()} /><Button type="submit" variant="quiet" disabled={!selected().length || busy()}>批量下载</Button></form>
      <Button variant="quiet" disabled={!selected().length || busy()} onClick={regenerate}>批量重新生成</Button>
      <form action="/books/archive" method="post" onSubmit={event => { event.preventDefault(); setArchiveForm(event.currentTarget); }}><SelectedIds ids={selected()} /><Button type="submit" variant="quiet" disabled={!selected().length || busy()}>批量归档</Button></form>
    </div></div>
    <LibrarySection data={props.data} view={view()} selecting={selecting()} selected={selected()} toggle={toggle} confirmArchive={setArchiveForm} />
    <ConfirmDialog open={Boolean(archiveForm())} title="归档书籍" confirmLabel="归档" onClose={() => setArchiveForm(null)} onConfirm={() => archiveForm()?.submit()}>确定归档选中的书籍吗？归档后可在归档页恢复。</ConfirmDialog>
  </div>;
}
