import TablerArchive from "~icons/tabler/archive";
import TablerBook from "~icons/tabler/book";
import TablerCheck from "~icons/tabler/check";
import TablerLayoutGrid from "~icons/tabler/layout-grid";
import TablerListDetails from "~icons/tabler/list-details";
import TablerMenu2 from "~icons/tabler/menu-2";
import TablerPlus from "~icons/tabler/plus";
import TablerRefresh from "~icons/tabler/refresh";
import TablerSortAscending from "~icons/tabler/sort-ascending";
import TablerTrash from "~icons/tabler/trash";
import TablerArrowUpRight from "~icons/tabler/arrow-up-right";
import TablerCircleCheck from "~icons/tabler/circle-check";
import TablerDeviceTablet from "~icons/tabler/device-tablet";
import TablerDotsVertical from "~icons/tabler/dots-vertical";
import TablerDownload from "~icons/tabler/download";
import TablerSend from "~icons/tabler/send";
import { createEffect, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { BookCover, Button, CloseButton, ConfirmDialog, EmptyState, GeneratedCover, Icon, Menu, LinkTabs, PageIntro, PageTabs, Pagination, SearchPill, SegmentedControl, SelectPill, ToggleChip, Toolbar, coverStateLabel, type CoverState } from "../../ui";
import type { LibrarySummary } from "./summary";
import { showToast } from "../../client/toast";
import { browserSupportsWebAuthn } from "../../client/passkeys";
import { Link } from "../../shared/spa-link";
import { useMutation } from "../../shared/client-mutation";
import { mutateLibrarySelection } from "./mutations";
import type { BookView } from "../../server/book-view";
import type { LibraryPageData } from "../../server/library/queries";
import { bookHref, devicePreviewHref, deviceTransferHref, gridPageSize, libraryReturnTo, rememberGridPageSize, type LibrarySearch } from "./search";

type View = "grid" | "list";
type LibraryDisplayData = LibraryPageData & { summary?: LibrarySummary };
export function shelfCoverState(book: BookView, generating = false): CoverState | undefined {
  return generating ? "generating" : book.status_class === "failed" ? "failed" : book.read ? "read" : undefined;
}
export function libraryIntro(summary?: LibrarySummary): string {
  const hero = summary?.hero;
  if (!hero) return "给喜欢的书，留一个位置。";
  const verb = summary.latest ? "阅读" : "放进来";
  return [...hero.title].length > 12 ? `最近${verb}的是这本。` : `最近${verb}的，是《${hero.title}》。`;
}
export function LibraryBook(props: { book: BookView; returnTo: string; view: View; selecting: boolean; selected: boolean; toggle: () => void; generating?: boolean; confirmArchive?: (form: HTMLFormElement) => void; confirmDelete?: (form: HTMLFormElement) => void; restoreBook?: (id: string) => void }) {
  const book = () => props.book;
  const state = () => shelfCoverState(book(), props.generating);
  const label = () => `打开《${book().title}》详情${state() ? `（${coverStateLabel[state()!]}）` : ""}`;
  const menuLabel = () => `《${book().title}》的操作${
    state() === "failed" ? `（${coverStateLabel.failed}）` : state() === "generating" ? `（${coverStateLabel.generating}）` : book().read ? "（已读）" : ""
  }`;
  return <article class={`library-book ${book().archived ? "is-archived" : ""} ${props.selected ? "is-selected" : ""}`} data-book-card data-book-id={book().book_id} data-book-layout={props.view}>
    <div class="library-cover">
      <Show when={book().archived} fallback={<BookCover {...book()} state={state()} compact={props.view === "list"} />}><GeneratedCover {...book()} state={state()} compact={props.view === "list"} /></Show>
      <Show when={props.selecting} fallback={<Show when={!book().archived}><Link class="library-cover-link" data-book-detail-link href={bookHref(book().book_id, props.returnTo)} aria-label={label()} /></Show>}>
        <button type="button" data-book-select class="library-cover-link" aria-label={`选择《${book().title}》`} aria-pressed={props.selected ? "true" : "false"} onClick={props.toggle}><span class="library-selection-mark" aria-hidden="true"><Icon icon={props.selected ? TablerCheck : TablerPlus} size={20} /></span></button>
      </Show>
    </div>
    <Show when={props.selecting} fallback={<div class="library-book-row">
      <span class="library-book-info"><span class="library-title">{book().title}</span><Show when={book().author}><span class="library-author">{book().author}</span></Show></span>
      <Menu title={book().title} subtitle={book().author || undefined} class="library-menu" dialogClass="library-book-menu" align="end" triggerLabel={menuLabel()} triggerTitle="更多操作" chevron={false}
        statusTone={state() === "failed" ? "danger" : "ok"} status={state() === "failed" ? "生成失败 · 点封面查看并重试" : book().read ? "已读" : undefined}
        trigger={<Icon icon={TablerDotsVertical} size={18} />}
        items={book().archived ? [
          { label: "恢复", icon: TablerRefresh, phoneIcon: TablerRefresh, action: `/book/${book().book_id}/restore`, fields: { next: props.returnTo }, onSubmit: event => { if (props.restoreBook) { event.preventDefault(); props.restoreBook(book().book_id); } } },
          { label: "彻底删除", icon: TablerTrash, phoneIcon: TablerTrash, destructive: true, action: `/book/${book().book_id}/delete`, fields: { next: props.returnTo }, onSubmit: event => { if (props.confirmDelete) { event.preventDefault(); props.confirmDelete(event.currentTarget); } } },
        ] : [
          { label: "详情", icon: TablerListDetails, phoneIcon: TablerBook, class: "library-phone-action", href: bookHref(book().book_id, props.returnTo) },
          { label: "阅读", icon: TablerBook, phoneIcon: TablerArrowUpRight, href: bookHref(book().book_id, props.returnTo, true) },
          { label: "设备预览", icon: TablerDeviceTablet, class: "library-desktop-action", href: devicePreviewHref(book().book_id) },
          { label: "下载", icon: TablerDownload, class: "library-desktop-action", href: `/book/${book().book_id}/download`, native: true },
          { label: "下载 EPUB", icon: TablerDownload, phoneIcon: TablerDownload, class: "library-phone-action", href: `/book/${book().book_id}/download`, native: true },
          ...(state() === "generating" ? [{ label: "查看生成进度", icon: TablerRefresh, phoneIcon: TablerRefresh, href: "/ingest?jobs_tab=running#jobs" }] : []),
          { label: "归档", icon: TablerArchive, phoneIcon: TablerArchive, separatorBefore: true, action: `/book/${book().book_id}/archive`, fields: { next: props.returnTo }, onSubmit: event => { if (props.confirmArchive) { event.preventDefault(); props.confirmArchive(event.currentTarget); } } },
        ]} />
    </div>}>
      <ToggleChip class="library-select-title" selected={props.selected} onClick={props.toggle}>{book().title}</ToggleChip>
    </Show>
  </article>;
}

export function LibrarySection(props: { data: LibraryDisplayData; loading?: boolean; view?: View; selecting?: boolean; selected?: string[]; toggle?: (id: string) => void; confirmArchive?: (form: HTMLFormElement) => void; confirmDelete?: (form: HTMLFormElement) => void; restoreBook?: (id: string) => void }) {
  return <div id="library-section" data-page={props.data.page} data-total-books={props.data.total_books}>
    <div id="library" class={`library-collection ${props.selecting ? "is-selecting" : ""} ${props.loading ? "is-loading" : ""}`} aria-busy={props.loading ? "true" : "false"} data-view={props.view || "grid"}>
      <Show when={props.data.books.length} fallback={<Show when={props.data.scope === "archived"} fallback={<EmptyState title="书库还是空的" action={<Link href="/ingest" class="btn btn-primary">入库第一本书</Link>}>上传 TXT 或 EPUB，开始整理你的书库。</EmptyState>}><EmptyState title="归档为空。" /></Show>}>
        <For each={props.data.books}>{book => <LibraryBook book={book} generating={props.data.summary?.generating_ids.includes(book.book_id)} returnTo={props.data.return_to} view={props.view || "grid"} selecting={Boolean(props.selecting)} selected={Boolean(props.selected?.includes(book.book_id))} toggle={() => props.toggle?.(book.book_id)} confirmArchive={props.confirmArchive} confirmDelete={props.confirmDelete} restoreBook={props.restoreBook} />}</For>
      </Show>
    </div>
    <Pagination page={props.data.page} perPage={props.data.per_page} total={props.data.total_books} shown={props.data.books.length} unit="册" href={props.data.return_to} />
  </div>;
}

export function SelectedIds(props: { ids: string[] }) {
  return <div data-book-ids><For each={props.ids}>{id => <input type="hidden" name="book_ids" value={id} />}</For></div>;
}

export function LibraryPage(props: {
  data: LibraryDisplayData; initialView?: View; passkeyPrompt?: boolean;
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
    const syncView = () => setView(saved());
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
  const heroBook = () => props.data.summary?.hero;
  return <div class="library-page" ref={page}>
    <PageIntro class="library-intro" visualSize={heroBook() ? "cover" : undefined} eyebrow={`书库 · 在库 ${props.data.summary?.active_count ?? (archived() ? 0 : props.data.total_books)} 册`} title={(() => { const intro = libraryIntro(props.data.summary), comma = intro.indexOf("，"); return comma < 0 ? intro : <>{intro.slice(0, comma + 1)}<br />{intro.slice(comma + 1)}</>; })()}
      description={props.data.summary?.hero?.description || "把喜欢的书放在一起，随时接着读。"}
      actions={<div class="library-intro-actions"><Show when={heroBook()} fallback={<Link href="/ingest" class="btn btn-primary btn-lg">开始入库</Link>}>{hero => <>
        <Link class="btn btn-primary btn-lg" href={bookHref(hero().book_id, props.data.return_to, true)}>{props.data.summary?.latest ? "继续阅读" : "开始阅读"}<Icon icon={TablerArrowUpRight} size={16} /></Link>
        <Link class="btn btn-icon btn-lg library-desktop-action" href={devicePreviewHref(hero().book_id)} aria-label={`在设备排版中预览《${hero().title}》`} title="设备预览"><Icon icon={TablerDeviceTablet} size={20} /></Link>
        <Link class="btn btn-icon btn-lg library-desktop-action" href={deviceTransferHref([hero().book_id])} aria-label={`发送《${hero().title}》到设备`} title="发送到设备"><Icon icon={TablerSend} size={20} /></Link>
        <a class="btn btn-icon btn-lg" href={`/book/${hero().book_id}/download`} aria-label={`下载《${hero().title}》`} title="下载"><Icon icon={TablerDownload} size={20} /></a>
      </>}</Show></div>}
      visual={heroBook() ? <Link href={bookHref(heroBook()!.book_id, props.data.return_to)} aria-label={`打开《${heroBook()!.title}》详情`}><BookCover {...heroBook()!} large eager /></Link> : undefined} />
    <Show when={showPasskeyHint()}><div class="passkey-hint" role="status"><Link href="/security">添加通行密钥，下次免密码登录</Link><CloseButton aria-label="关闭添加通行密钥提示" onClick={dismissPasskeyHint} /></div></Show>
    <div class="library-head">
      <PageTabs label="书架" value={props.data.scope} tabs={[
        { value: "active", label: "在库", count: props.data.summary?.active_count, href: libraryReturnTo({ ...props.data, scope: "active", read_filter: "all", page: 1 }) },
        { value: "archived", label: "已归档", count: props.data.summary?.archived_count, href: libraryReturnTo({ ...props.data, scope: "archived", read_filter: "all", page: 1 }) },
      ]} />
      <form id="library-controls" class="library-controls" action="/" method="get" hidden={selecting()} onSubmit={event => { event.preventDefault(); void search({}); }}>
        <input type="hidden" name="scope" value={props.data.scope} /><input type="hidden" name="read_filter" value={props.data.read_filter} /><input type="hidden" name="page" value="1" data-page-input /><input type="hidden" name="per_page" value={props.data.per_page} data-per-page-input />
        <Toolbar search={<div class="library-search-row"><SearchPill label="搜索书名、作者" name="q" placeholder="搜索书名、作者" value={query()} onInput={event => { setQuery(event.currentTarget.value); clearTimeout(timer); timer = setTimeout(() => void search({}), 400); }} /><Button class="library-search-batch library-phone-action" variant="secondary" aria-label="批量选择" title="批量选择" aria-pressed={selecting() ? "true" : "false"} onClick={() => setSelecting(true)}><Icon icon={TablerCircleCheck} size={18} /></Button></div>}>
          <Show when={!archived()}><LinkTabs label="阅读状态" value={props.data.read_filter} tabs={(["all", "unread"] as const).map(value => ({ value, label: value === "all" ? "全部" : "未读", href: libraryReturnTo({ ...props.data, q: query(), read_filter: value, page: 1 }) }))} onNavigate={value => void search({ read_filter: value === "unread" ? "unread" : "all" })} /></Show>
          <SelectPill label="排序" icon={TablerSortAscending} class="library-sort" name="sort" value={props.data.sort} options={[{ value: "updated", label: "最近修改" }, { value: "created", label: "最近导入" }]} onChange={value => void search({ sort: value === "created" ? "created" : "updated" })} />
          <span class="library-toolbar-divider" aria-hidden="true" />
          <SegmentedControl label="显示方式" class="library-view-toggle" value={view()} options={[{ value: "grid", label: "封面墙", icon: TablerLayoutGrid }, { value: "list", label: "列表", icon: TablerMenu2 }]} onChange={value => changeView(value as View)} />
          <Button data-bulk-mode-toggle class="library-desktop-action" variant="secondary" aria-pressed={selecting() ? "true" : "false"} onClick={() => setSelecting(true)}><Icon icon={TablerCircleCheck} size={16} />批量选择</Button>
        </Toolbar>
      </form>
    </div>
    <div data-bulk-controls><div class="library-bulk" data-bulk-actions role="toolbar" aria-label="批量操作" hidden={!selecting()}>
      <div class="library-bulk-actions">
      <ToggleChip data-bulk-select-all selected={Boolean(props.data.books.length) && selected().length === props.data.books.length} onClick={() => setSelected(selected().length === props.data.books.length ? [] : props.data.books.map(book => book.book_id))}>全选本页</ToggleChip>
      <span class="library-bulk-count" aria-live="polite">已选 <strong data-selected-count>{selected().length}</strong> 册</span>
      <Button data-bulk-clear variant="quiet" disabled={!selected().length} onClick={() => setSelected([])}>清空</Button>
      <span class="library-bulk-divider" aria-hidden="true" />
      <Show when={archived()} fallback={<>
      <form action="/books/download" method="post" onSubmit={download}><SelectedIds ids={selected()} /><Button type="submit" variant="quiet" disabled={!selected().length || busy()}>下载</Button></form>
      <Button class="library-desktop-action" variant="quiet" disabled={!selected().length || busy()} onClick={() => void mutation.router.navigate({ href: deviceTransferHref(selected()) })}>发送到设备</Button>
      <Button class="library-desktop-action" variant="quiet" disabled={selected().length !== 1 || busy()} title={selected().length > 1 ? "一次预览一本书" : undefined} onClick={() => void mutation.router.navigate({ href: devicePreviewHref(selected()[0]!) })}>设备预览</Button>
      <Button variant="quiet" disabled={!selected().length || busy()} onClick={regenerate}>重新生成</Button>
      <form action="/books/archive" method="post" onSubmit={event => { event.preventDefault(); setArchiveForm(event.currentTarget); }}><SelectedIds ids={selected()} /><Button type="submit" variant="quiet" disabled={!selected().length || busy()}>归档</Button></form>
      </>}><Button variant="quiet" disabled={!selected().length || busy()} onClick={() => void restore()}>恢复</Button><form action="/archive/delete-bulk" method="post" onSubmit={event => { event.preventDefault(); setDeleteForm(event.currentTarget); }}><SelectedIds ids={selected()} /><Button type="submit" variant="quiet-danger" disabled={!selected().length || busy()}>彻底删除</Button></form></Show>
      </div>
      <Button data-bulk-done variant="secondary" size="sm" class="library-bulk-done" onClick={done}>完成</Button>
    </div></div>
    <LibrarySection data={props.data} loading={props.loading} view={view()} selecting={selecting()} selected={selected()} toggle={toggle} confirmArchive={setArchiveForm} confirmDelete={setDeleteForm} restoreBook={id => void restore([id])} />
    <ConfirmDialog open={Boolean(archiveForm())} title="归档书籍" confirmLabel="归档" onClose={() => setArchiveForm(null)} onConfirm={() => confirm("archive", archiveForm())}>确定归档选中的书籍吗？归档后可在书库「已归档」中恢复。</ConfirmDialog>
    <ConfirmDialog open={Boolean(deleteForm())} title="永久删除书籍" danger confirmLabel="彻底删除" onClose={() => setDeleteForm(null)} onConfirm={() => confirm("delete", deleteForm())}>确定永久删除？书籍文件删除后无法恢复。</ConfirmDialog>
  </div>;
}
