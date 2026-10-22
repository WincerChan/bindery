import { createEffect, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { BookCover, Button, Checkbox, ConfirmDialog, EmptyState, GeneratedCover, PageHeader, Pagination, Tag, TextField } from "../../ui";
import { showToast } from "../../client/toast";
import { browserSupportsWebAuthn } from "../../client/passkeys";
import { Link } from "../../shared/spa-link";
import { useMutation } from "../../shared/client-mutation";
import { mutateLibrarySelection } from "./mutations";
import type { BookView } from "../../server/book-view";
import type { LibraryPageData } from "../../server/library/queries";
import { bookHref, devicePreviewHref, deviceTransferHref, gridPageSize, libraryReturnTo, rememberGridPageSize, type LibrarySearch } from "./search";

type View = "grid" | "list";
export function LibraryBook(props: { book: BookView; returnTo: string; view: View; selecting: boolean; selected: boolean; toggle: () => void; confirmArchive?: (form: HTMLFormElement) => void; confirmDelete?: (form: HTMLFormElement) => void; restoreBook?: (id: string) => void }) {
  const book = () => props.book;
  return <article class={`library-book ${book().archived ? "is-archived" : ""} ${props.selected ? "is-selected" : ""}`} data-book-card data-book-id={book().book_id} data-book-layout={props.view}>
    <div class="library-selection" data-book-select-wrap hidden={!props.selecting}>
      <Checkbox data-book-select label={`选择《${book().title}》`} value={book().book_id} checked={props.selected} onChange={props.toggle} />
    </div>
    <div class="library-cover">
      <Show when={book().archived} fallback={<BookCover {...book()} compact={props.view === "list"} />}><GeneratedCover {...book()} compact={props.view === "list"} /></Show>
      <Show when={props.selecting} fallback={<Show when={!book().archived}><>
        <Link class="library-cover-link" data-book-detail-link href={bookHref(book().book_id, props.returnTo)} aria-label={`打开《${book().title}》详情`} />
        <Link class="library-hover-read" data-book-hover-actions href={bookHref(book().book_id, props.returnTo, true)}>阅读</Link>
      </></Show>}><button type="button" class="library-cover-link" aria-label={`选择《${book().title}》`} aria-pressed={props.selected ? "true" : "false"} onClick={props.toggle} /></Show>
    </div>
    <div class="library-book-info">
      <Show when={props.selecting} fallback={<Show when={!book().archived} fallback={<h2 class="library-title" title={book().title}>{book().title}</h2>}><Link class="library-title" data-book-detail-link href={bookHref(book().book_id, props.returnTo)} title={book().title}>{book().title}</Link></Show>}>
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
      <Show when={book().archived} fallback={<>
      <Link class="btn btn-secondary btn-sm" href={bookHref(book().book_id, props.returnTo, true)}>阅读</Link>
      <a class="btn btn-quiet btn-sm library-desktop-action" href={`/book/${book().book_id}/download`}>下载</a>
      <Link class="btn btn-quiet btn-sm library-desktop-action" href={devicePreviewHref(book().book_id)} aria-label={`在设备排版中预览《${book().title}》`}>设备预览</Link>
      <Link class="btn btn-quiet btn-sm library-desktop-action" href={deviceTransferHref([book().book_id])} aria-label={`发送《${book().title}》到设备`}>发送</Link>
      <form class="library-desktop-action" action={`/book/${book().book_id}/archive`} method="post" onSubmit={event => {
        if (props.confirmArchive) { event.preventDefault(); props.confirmArchive(event.currentTarget); }
      }}><input type="hidden" name="next" value={props.returnTo} /><Button type="submit" variant="quiet" size="sm">归档</Button></form>
      </>}><form action={`/book/${book().book_id}/restore`} method="post" onSubmit={event => { if (props.restoreBook) { event.preventDefault(); props.restoreBook(book().book_id); } }}><input type="hidden" name="next" value={props.returnTo} /><Button type="submit" variant="secondary" size="sm">恢复</Button></form><form action={`/book/${book().book_id}/delete`} method="post" onSubmit={event => { event.preventDefault(); props.confirmDelete?.(event.currentTarget); }}><input type="hidden" name="next" value={props.returnTo} /><Button type="submit" variant="danger" size="sm">彻底删除</Button></form></Show>
    </div>
  </article>;
}

export function LibrarySection(props: { data: LibraryPageData; loading?: boolean; view?: View; selecting?: boolean; selected?: string[]; toggle?: (id: string) => void; confirmArchive?: (form: HTMLFormElement) => void; confirmDelete?: (form: HTMLFormElement) => void; restoreBook?: (id: string) => void }) {
  return <div id="library-section" data-page={props.data.page} data-total-books={props.data.total_books}>
    <div id="library" class={`library-collection ${props.selecting ? "is-selecting" : ""} ${props.loading ? "is-loading" : ""}`} aria-busy={props.loading ? "true" : "false"} data-view={props.view || "grid"}>
      <Show when={props.data.books.length} fallback={<Show when={props.data.scope === "archived"} fallback={<EmptyState title="书库还是空的" action={<Link href="/ingest" class="btn btn-primary">入库第一本书</Link>}>上传 TXT 或 EPUB，开始整理你的书库。</EmptyState>}><EmptyState title="归档为空。" /></Show>}>
        <div class="library-list-head" data-library-list-head aria-hidden="true"><span>书名 / 作者</span><span>出版</span><span>格式</span><span>更新</span><span>操作</span></div>
        <For each={props.data.books}>{book => <LibraryBook book={book} returnTo={props.data.return_to} view={props.view || "grid"} selecting={Boolean(props.selecting)} selected={Boolean(props.selected?.includes(book.book_id))} toggle={() => props.toggle?.(book.book_id)} confirmArchive={props.confirmArchive} confirmDelete={props.confirmDelete} restoreBook={props.restoreBook} />}</For>
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
  data: LibraryPageData; initialView?: View; passkeyPrompt?: boolean;
  onSearch?: (search: LibrarySearch) => unknown | Promise<unknown>;
  /** Results are reloading in place; the current ones stay visible. */
  loading?: boolean;
  restore?: (ids: string[]) => Promise<unknown>; refresh?: () => Promise<unknown>;
  regenerate: (ids: string[]) => Promise<{ queued: number; failed: number; skipped: number }>;
}) {
  const mutation = useMutation();
  const refresh = () => props.refresh ? props.refresh() : mutation.router.invalidate();
  const [view, setView] = createSignal<View>(untrack(() => props.initialView || "grid")), [selecting, setSelecting] = createSignal(false), [selected, setSelected] = createSignal<string[]>([]);
  const [query, setQuery] = createSignal(untrack(() => props.data.q)), [downloading, setBusy] = createSignal(false), [archiveForm, setArchiveForm] = createSignal<HTMLFormElement | null>(null), [deleteForm, setDeleteForm] = createSignal<HTMLFormElement | null>(null);
  const [passkeyHintDismissed, setPasskeyHintDismissed] = createSignal(false), [webauthnSupported, setWebauthnSupported] = createSignal(typeof window === "undefined");
  const showPasskeyHint = () => Boolean(props.passkeyPrompt) && webauthnSupported() && !passkeyHintDismissed();
  function dismissPasskeyHint() {
    setPasskeyHintDismissed(true);
    try { localStorage.setItem("bindery-passkey-hint-dismissed", "1"); } catch { /* The hint still closes for this view. */ }
  }
  const busy = () => downloading() || mutation.busy();
  const archived = () => props.data.scope === "archived";
  let previousScope = untrack(() => props.data.scope);
  createEffect(() => props.data.scope, scope => { if (scope !== previousScope) { setSelected([]); setSelecting(false); } previousScope = scope; });
  let page!: HTMLDivElement, timer: ReturnType<typeof setTimeout> | undefined;
  // Results for an earlier keystroke must not overwrite what is being typed; other changes (back/forward) sync.
  let sentQuery: string | null = null;
  createEffect(() => props.data.q, q => { if (q !== sentQuery) setQuery(q); sentQuery = null; });
  createEffect(() => props.data.books.map(book => book.book_id), ids => { setSelected(current => current.filter(id => ids.includes(id))); });
  onCleanup(() => clearTimeout(timer));
  async function search(overrides: Partial<LibrarySearch>) {
    clearTimeout(timer);
    const value = { scope: props.data.scope, sort: props.data.sort, q: query(), read_filter: props.data.read_filter, per_page: props.data.per_page, page: 1, ...overrides };
    sentQuery = value.q;
    try { if (props.onSearch) await props.onSearch(value); else await mutation.router.navigate({ href: libraryReturnTo(value) }); }
    catch (error) { showToast(error instanceof Error ? error.message : "加载失败，请重试", "error"); }
  }
  onSettled(() => {
    if (typeof window === "undefined") return;
    setWebauthnSupported(browserSupportsWebAuthn());
    try { setPasskeyHintDismissed(localStorage.getItem("bindery-passkey-hint-dismissed") === "1"); } catch { /* Storage may be disabled. */ }
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
        if (!width) return;
        rememberGridPageSize(per_page);
        if (per_page !== props.data.per_page) void search({ per_page });
      }, 150);
    };
    const observer = new ResizeObserver(syncSize); observer.observe(page);
    return () => { media.removeEventListener("change", syncView); observer.disconnect(); clearTimeout(widthTimer); };
  });
  function changeView(next: View) {
    setView(next);
    try { localStorage.setItem("bindery-view", next); } catch { /* View still works when storage is disabled. */ }
    if (next === "grid") { const width = page.querySelector<HTMLElement>("#library")?.clientWidth || 0; if (width) { rememberGridPageSize(gridPageSize(width)); void search({ per_page: gridPageSize(width) }); } }
  }
  const toggle = (id: string) => setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  function done() { setSelecting(false); setSelected([]); }
  async function regenerate() {
    await mutation.run(() => props.regenerate(selected()), async result => {
      if (!result.queued) throw new Error(result.failed ? "任务队列已满，请稍后重试" : "没有匹配的书籍可批量处理");
      showToast(`已创建 ${result.queued} 个任务${result.failed ? `，${result.failed} 个任务入队失败` : ""}`, result.failed ? "warning" : "success");
      await mutation.router.navigate({ href: "/ingest?jobs_tab=running#jobs" });
    });
  }
  async function restore(ids = selected()) {
    await mutation.run(() => props.restore ? props.restore(ids) : mutateLibrarySelection({ data: { action: "restore", ids } }), async () => { setSelected([]); await refresh(); }, "已恢复书籍");
  }
  async function confirm(action: "archive" | "delete", form: HTMLFormElement | null) {
    if (!form) return;
    const match = /\/book\/([^/]+)\//.exec(form.getAttribute("action") || "");
    const ids = match ? [match[1]!] : selected();
    await mutation.run(() => mutateLibrarySelection({ data: { action, ids } }), async () => { setSelected([]); await refresh(); }, action === "archive" ? "已归档书籍" : "已永久删除书籍", true);
  }
  async function download(event: SubmitEvent) {
    event.preventDefault(); setBusy(true);
    const form = event.currentTarget as HTMLFormElement;
    try {
      const response = await fetch(form.action, { method: "POST", body: new FormData(form) });
      if (response.redirected && new URL(response.url).pathname === "/login") { await mutation.router.navigate({ href: response.url }); return; }
      if (!response.ok) { const data = await response.json(); throw new Error(data.detail || "下载失败"); }
      const blob = await response.blob(), url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "")?.[1] || "bindery-books.zip";
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { showToast(error instanceof Error ? error.message : "下载失败，请重试", "error"); }
    finally { setBusy(false); }
  }
  return <div class="library-page" ref={page}>
    <PageHeader title="书库" description={<>{archived() ? "已归档" : "共"} <span data-library-count>{props.data.total_books}</span> 册{!archived() && props.data.read_filter === "unread" ? " · 仅看未读" : ""}</>} actions={<Link href="/ingest" class="btn btn-primary">+ 入库</Link>} />
    <Show when={showPasskeyHint()}><div class="passkey-hint" role="status"><Link href="/security">添加通行密钥，下次免密码登录</Link><button type="button" class="quiet" aria-label="关闭添加通行密钥提示" onClick={dismissPasskeyHint}>×</button></div></Show>
    <nav class="library-shelves" aria-label="书架">
      <Link href={libraryReturnTo({ ...props.data, scope: "active", read_filter: "all", page: 1 })} aria-current={archived() ? undefined : "page"}>在库</Link>
      <Link data-scope-toggle href={libraryReturnTo({ ...props.data, scope: "archived", read_filter: "all", page: 1 })} aria-current={archived() ? "page" : undefined}>已归档</Link>
    </nav>
    <form id="library-controls" class="library-controls" action="/" method="get" hidden={selecting()} onSubmit={event => { event.preventDefault(); void search({}); }}>
      <TextField class="library-search search-field" label="搜索书名、作者" labelHidden type="search" name="q" placeholder="搜索书名、作者" value={query()} onInput={event => { setQuery(event.currentTarget.value); clearTimeout(timer); timer = setTimeout(() => void search({}), 400); }} />
      <input type="hidden" name="scope" value={props.data.scope} /><input type="hidden" name="read_filter" value={props.data.read_filter} /><input type="hidden" name="page" value="1" data-page-input /><input type="hidden" name="per_page" value={props.data.per_page} data-per-page-input />
      <Show when={!archived()}><Checkbox data-read-filter-toggle label="仅看未读" checked={props.data.read_filter === "unread"} onChange={event => void search({ read_filter: event.currentTarget.checked ? "unread" : "all" })} /></Show>
      <div class="library-tools">
        <label class="inline-select inline-select-plain"><span>排序</span><select name="sort" value={props.data.sort} onChange={event => void search({ sort: event.currentTarget.value === "created" ? "created" : "updated" })}><option value="updated">最近修改</option><option value="created">最近导入</option></select></label>
        <div class="segmented library-view-toggle" role="group" aria-label="显示方式">
          <button type="button" aria-label="封面墙" aria-pressed={view() === "grid" ? "true" : "false"} onClick={() => changeView("grid")}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z" stroke="currentColor" stroke-width="1.7" /></svg></button>
          <button type="button" aria-label="列表" aria-pressed={view() === "list" ? "true" : "false"} onClick={() => changeView("list")}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg></button>
        </div>
        <Button data-bulk-mode-toggle variant="quiet" class="library-select-toggle" aria-pressed={selecting() ? "true" : "false"} onClick={() => setSelecting(true)}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" stroke-width="1.7" /><path d="M8 12.5l2.5 2.5L16 9.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>选择</Button>
      </div>
    </form>
    <div data-bulk-controls><div class="library-bulk" data-bulk-actions role="toolbar" aria-label="批量操作" hidden={!selecting()}>
      <Checkbox data-bulk-select-all label="全选本页" checked={Boolean(props.data.books.length) && selected().length === props.data.books.length} indeterminate={selected().length > 0 && selected().length < props.data.books.length} onChange={event => setSelected(event.currentTarget.checked ? props.data.books.map(book => book.book_id) : [])} />
      <span class="library-bulk-count" aria-live="polite">已选 <strong data-selected-count>{selected().length}</strong> 册</span>
      <Button data-bulk-clear variant="quiet" disabled={!selected().length} onClick={() => setSelected([])}>清空</Button>
      <span class="library-bulk-divider" aria-hidden="true" />
      <Show when={archived()} fallback={<>
      <form action="/books/download" method="post" onSubmit={download}><SelectedIds ids={selected()} /><Button type="submit" variant="quiet" disabled={!selected().length || busy()}>下载</Button></form>
      <Button variant="quiet" disabled={!selected().length || busy()} onClick={() => void mutation.router.navigate({ href: deviceTransferHref(selected()) })}>发送到设备</Button>
      <Button variant="quiet" disabled={selected().length !== 1 || busy()} title={selected().length > 1 ? "一次预览一本书" : undefined} onClick={() => void mutation.router.navigate({ href: devicePreviewHref(selected()[0]!) })}>设备预览</Button>
      <Button variant="quiet" disabled={!selected().length || busy()} onClick={regenerate}>重新生成</Button>
      <form action="/books/archive" method="post" onSubmit={event => { event.preventDefault(); setArchiveForm(event.currentTarget); }}><SelectedIds ids={selected()} /><Button type="submit" variant="quiet" disabled={!selected().length || busy()}>归档</Button></form>
      </>}><Button variant="quiet" disabled={!selected().length || busy()} onClick={() => void restore()}>恢复</Button><form action="/archive/delete-bulk" method="post" onSubmit={event => { event.preventDefault(); setDeleteForm(event.currentTarget); }}><SelectedIds ids={selected()} /><Button type="submit" variant="quiet-danger" disabled={!selected().length || busy()}>彻底删除</Button></form></Show>
      <Button data-bulk-done variant="secondary" size="sm" class="library-bulk-done" onClick={done}>完成</Button>
    </div></div>
    <LibrarySection data={props.data} loading={props.loading} view={view()} selecting={selecting()} selected={selected()} toggle={toggle} confirmArchive={setArchiveForm} confirmDelete={setDeleteForm} restoreBook={id => void restore([id])} />
    <ConfirmDialog open={Boolean(archiveForm())} title="归档书籍" confirmLabel="归档" onClose={() => setArchiveForm(null)} onConfirm={() => confirm("archive", archiveForm())}>确定归档选中的书籍吗？归档后可在书库「已归档」中恢复。</ConfirmDialog>
    <ConfirmDialog open={Boolean(deleteForm())} title="永久删除书籍" danger confirmLabel="彻底删除" onClose={() => setDeleteForm(null)} onConfirm={() => confirm("delete", deleteForm())}>确定永久删除？书籍文件删除后无法恢复。</ConfirmDialog>
  </div>;
}
