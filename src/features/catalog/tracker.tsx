import TablerBook2 from "~icons/tabler/book-2";
import TablerPencil from "~icons/tabler/pencil";
import TablerArrowRight from "~icons/tabler/arrow-right";
import TablerDotsVertical from "~icons/tabler/dots-vertical";
import TablerDownload from "~icons/tabler/download";
import TablerPlus from "~icons/tabler/plus";
import TablerTrash from "~icons/tabler/trash";
import TablerX from "~icons/tabler/x";
import { createSignal, createUniqueId, For, onCleanup, Show, untrack } from "solid-js";
import { Button, CenterDialog, ConfirmDialog, EmptyState, Icon, Menu, LinkTabs, RatingInput, StarRating, RelativeTime, Pagination, PageIntro, SearchPill, SectionTitle, SegmentedControl, SelectPill, Textarea, TextField, Toolbar } from "../../ui";
import type { DuplicateData, TrackerItem, TrackerPageData } from "../../server/catalog/tracker";
import { isRedirect } from "@tanstack/solid-router";
import { Link } from "../../shared/spa-link";
import { formFields, useMutation } from "../../shared/client-mutation";
import { showToast } from "../../client/toast";
import { checkTracker, deleteTracker, saveTracker } from "./mutations";
import { TrackerCover, trackerBookHref, trackerReadOptions, trackerState, trackerStatusOptions } from "./tracker-parts";

const parseTags = (value?: string) => {
  const seen = new Set<string>();
  return (value || "").split(/[，,\n]+/).map(tag => tag.trim()).filter(tag => {
    if (!tag || seen.has(tag.toLowerCase())) return false;
    seen.add(tag.toLowerCase());
    return true;
  });
};

/** Tag chips are the editing surface; the hidden input keeps the server's comma-separated contract. */
function TagInput(props: { value?: string }) {
  const [tags, setTags] = createSignal(untrack(() => parseTags(props.value)));
  const id = createUniqueId();
  let input!: HTMLInputElement;
  const add = (raw: string) => {
    const next = [...tags()];
    for (const part of raw.split(/[，,\n]+/)) {
      const tag = part.trim();
      if (tag && !next.some(value => value.toLowerCase() === tag.toLowerCase())) next.push(tag);
    }
    setTags(next);
  };
  const commit = () => { add(input.value); input.value = ""; };
  return <div class="field tracker-tags">
    <label for={id}>标签</label>
    <input type="hidden" name="tags" value={tags().join(",")} />
    <div class="tracker-tag-box" onClick={event => { if (event.target === event.currentTarget) input.focus(); }}>
      <For each={tags()}>{tag => <span class="tracker-tag">{tag}<button type="button" class="tracker-tag-remove" aria-label={`移除标签 ${tag}`} onClick={() => setTags(tags().filter(value => value !== tag))}><Icon icon={TablerX} size={12} /></button></span>}</For>
      <input ref={input} id={id} class="tracker-tag-input" type="text" aria-label="添加标签" placeholder="添加标签，回车确认"
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === "，" || event.key === ",") { event.preventDefault(); commit(); }
          else if (event.key === "Backspace" && !input.value && tags().length) setTags(tags().slice(0, -1));
        }}
        onBlur={commit} />
    </div>
  </div>;
}

export function TrackerForm(props: { wish?: TrackerItem; next: string; onClose: () => void; onDelete?: () => void }) {
  const mutation = useMutation();
  const [title, setTitle] = createSignal(untrack(() => props.wish?.title || "")), [author, setAuthor] = createSignal(untrack(() => props.wish?.author || ""));
  const [rating, setRating] = createSignal(untrack(() => props.wish?.rating == null ? "" : String(props.wish.rating)));
  const [read, setRead] = createSignal(untrack(() => props.wish?.read_status || "unread")), [status, setStatus] = createSignal(untrack(() => props.wish?.book_status || "completed"));
  const [duplicates, setDuplicates] = createSignal<DuplicateData | null>(null), [checking, setChecking] = createSignal(false), [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  let timeout: ReturnType<typeof setTimeout> | undefined, abort: AbortController | undefined, sequence = 0;
  onCleanup(() => { clearTimeout(timeout); abort?.abort(); sequence++; });
  const linked = () => Boolean(props.wish?.library_book_id);
  const heading = () => linked() ? title() : props.wish ? "编辑追踪" : "添加书籍";
  function check(nextTitle: string, nextAuthor: string) {
    if (props.wish) return;
    clearTimeout(timeout); abort?.abort(); const current = ++sequence;
    setDuplicates(null); setChecking(Boolean(nextTitle.trim()));
    if (!nextTitle.trim()) return;
    timeout = setTimeout(async () => {
      abort = new AbortController();
      try { const data = await checkTracker({ data: { title: nextTitle, author: nextAuthor }, signal: abort.signal }); if (current === sequence) { setDuplicates(data); setError(""); } }
      catch (error) { if (isRedirect(error)) { await mutation.router.navigate({ href: error.options.href || "/login" }); return; } if (current === sequence && !abort.signal.aborted) { const message = error instanceof Error ? error.message : "检查失败"; setError(message); showToast(message, "error"); } }
      finally { if (current === sequence) setChecking(false); }
    }, 250);
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (busy() || checking() || duplicates()?.exists) return; setBusy(true); setError("");
    const fields = formFields(event.currentTarget as HTMLFormElement);
    try {
      await mutation.run(() => saveTracker({ data: { id: props.wish?.id, fields } }), async result => {
        props.onClose(); await mutation.router.navigate({ href: result.target }); await mutation.router.invalidate();
      }, "已保存追踪");
    } finally { setBusy(false); }
  }
  return <form action={props.wish ? `/tracker/${props.wish.id}/update` : "/tracker"} method="post" onSubmit={submit} class="tracker-form">
    <input type="hidden" name="next" value={props.next} /><input type="hidden" name="library_book_id" value={props.wish?.library_book_id || ""} />
    <Show when={linked()}><input type="hidden" name="title" value={title()} /><input type="hidden" name="author" value={author()} /></Show>
    <div class="tracker-form-body">
      <aside class="tracker-form-cover"><TrackerCover wish={props.wish} title={title() || "书名"} author={author()} large />
        <Show when={props.wish?.library_book_id}><Link href={trackerBookHref(props.wish!, props.next)}>在书库中打开<Icon icon={TablerArrowRight} size={13} /></Link></Show>
      </aside>
      <div class="tracker-form-fields">
        <header class="tracker-form-head">
          <h2>{heading()}</h2>
          <Show when={linked()}><p>{author()}<Show when={author()}> · </Show><span>书名和作者跟随书库</span></p></Show>
        </header>
        <Show when={!linked()}><div class="tracker-identity">
          <TextField name="title" label="书名" value={title()} required onInput={event => { setTitle(event.currentTarget.value); check(event.currentTarget.value, author()); }} />
          <TextField name="author" label="作者" value={author()} onInput={event => { setAuthor(event.currentTarget.value); check(title(), event.currentTarget.value); }} />
        </div></Show>
        <Show when={duplicates()}><div class="tracker-duplicates" aria-live="polite">
          <Show when={duplicates()?.exists} fallback={<><p>已添加项目（共 {duplicates()?.matches.length || 0} 条）：</p><ul><For each={duplicates()?.matches || []}>{item => <li><Link href={`/tracker?duplicate=${item.id}`}>{item.title} · {item.author || "未知作者"} · 点此前往编辑</Link></li>}</For></ul></>}>
            <p>已存在追踪条目</p><For each={duplicates()?.blocking_matches || []}>{item => <p><Link href={`/tracker?duplicate=${item.id}`}>{item.title} · {item.author || "未知作者"} · 点此前往编辑该条目。</Link></p>}</For>
          </Show>
        </div></Show>
        <RatingInput value={rating()} onChange={setRating} />
        <div class="tracker-form-statuses">
          <fieldset><legend>阅读</legend><input type="hidden" name="read_status" value={read()} /><SegmentedControl label="阅读状态" value={read()} options={trackerReadOptions} onChange={setRead} /></fieldset>
          <fieldset><legend>连载</legend><input type="hidden" name="book_status" value={status()} /><SegmentedControl label="连载状态" value={status()} options={trackerStatusOptions} onChange={setStatus} /></fieldset>
        </div>
        <TagInput value={props.wish?.tags_text} />
        <Textarea name="comment" label="评论" rows={3} placeholder="记下你的阅读感受" value={props.wish?.comment || ""} />
        <Show when={error()}><p class="field-error" role="alert">{error()}</p></Show>
      </div>
    </div>
    <footer class="tracker-form-actions">
      <Show when={props.onDelete}><Button variant="quiet-danger" onClick={props.onDelete}><Icon icon={TablerTrash} size={16} />删除这条追踪</Button></Show>
      <div class="tracker-form-actions-main"><Button variant="quiet" size="lg" disabled={busy()} onClick={props.onClose}>取消</Button><Button type="submit" size="lg" disabled={busy() || checking() || Boolean(duplicates()?.exists)}>{busy() ? "保存中…" : checking() ? "检查中…" : "保存"}</Button></div>
    </footer>
  </form>;
}
export function TrackerPage(props: { data: TrackerPageData }) {
  const mutation = useMutation();
  const [active, setActive] = createSignal<{ wish?: TrackerItem } | null>(null), [deleting, setDeleting] = createSignal<TrackerItem | null>(null);
  let filterForm!: HTMLFormElement, searchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(searchTimer));
  const filtered = () => Boolean(props.data.filters.q) || [props.data.filters.read_filter, props.data.filters.library_filter, props.data.filters.book_status_filter].some(value => value !== "all");
  function applyFilters(override: Record<string, string> = {}) { clearTimeout(searchTimer); void mutation.router.navigate({ to: "/tracker", search: { ...formFields(filterForm), ...override } }); }
  function requestDelete(wish: TrackerItem) { setActive(null); setDeleting(wish); }
  async function remove() {
    await mutation.run(() => deleteTracker({ data: { id: deleting()!.id, next: props.data.current_url } }), async result => {
      setDeleting(null); await mutation.router.navigate({ href: result.target }); await mutation.router.invalidate();
    }, "已删除追踪", true);
  }
  const menuTone = (wish: TrackerItem) => wish.read_status === "read" ? "ok" as const : wish.read_status === "reading" ? "accent" as const : "neutral" as const;
  return <div class="tracker-page">
    <PageIntro eyebrow={`追踪 · 共 ${props.data.stats.total} 本 · ${props.data.stats.in_library} 本已入库`}
      title={<><Show when={props.data.stats.reading > 0}>正在读的有 {props.data.stats.reading} 本，<br /></Show>还有 {props.data.stats.unread} 本在等你。</>}
      description="想读的、读过的、还在连载的，都记在这里。没入库的书也可以先记下。"
      actions={<><Button size="lg" class="tracker-add" onClick={() => setActive({})}><Icon icon={TablerPlus} size={16} />添加书籍</Button><a class="btn btn-icon btn-lg" href={props.data.export_url} aria-label="导出 CSV" title="导出 CSV"><Icon icon={TablerDownload} size={20} /></a></>}
      visual={<Show when={props.data.reading_now.length}><section class="tracker-reading" aria-label="正在读"><SectionTitle>正在读</SectionTitle><div class="tracker-reading-covers"><For each={props.data.reading_now}>{wish => <Show when={wish.library_book_id} fallback={<button type="button" class="tracker-cover-button" aria-label={`编辑《${wish.title}》（${trackerState(wish)}）`} onClick={() => setActive({ wish })}><TrackerCover wish={wish} /></button>}><Link href={trackerBookHref(wish, props.data.current_url)} aria-label={`打开《${wish.title}》详情（${trackerState(wish)}）`}><TrackerCover wish={wish} /></Link></Show>}</For></div></section></Show>} />
    <Show when={props.data.duplicate_notice}><div class="tracker-notice" role="status"><p>已存在追踪条目：{props.data.duplicate_notice?.title}</p><Button variant="secondary" onClick={() => setActive({ wish: props.data.duplicate_notice! })}>点此前往编辑该条目。</Button></div></Show>
    <form ref={filterForm} action="/tracker" method="get" class="tracker-filter" onSubmit={event => { event.preventDefault(); applyFilters(); }}>
      <input type="hidden" name="read_filter" value={props.data.filters.read_filter} />
      <Toolbar label="追踪筛选" search={<SearchPill name="q" label="搜索书名、作者、标签" value={props.data.filters.q} placeholder="搜索书名、作者、标签" onInput={() => { clearTimeout(searchTimer); searchTimer = setTimeout(() => applyFilters(), 400); }} />}>
        <LinkTabs class="tracker-read-filter" label="阅读状态" value={props.data.filters.read_filter} tabs={[{ value: "all", label: "全部" }, ...trackerReadOptions].map(option => ({ ...option, href: `/tracker?${new URLSearchParams({ ...props.data.filters, read_filter: option.value })}` }))} onNavigate={value => applyFilters({ read_filter: value })} />
        <div class="tracker-filter-pills">
          <SelectPill name="library_filter" label="书库" value={props.data.filters.library_filter} options={[{ value: "all", label: "全部" }, { value: "in", label: "已入库" }, { value: "out", label: "未入库" }]} onChange={value => applyFilters({ library_filter: value })} />
          <SelectPill name="book_status_filter" label="连载" value={props.data.filters.book_status_filter} options={[{ value: "all", label: "全部" }, ...trackerStatusOptions]} onChange={value => applyFilters({ book_status_filter: value })} />
          <Show when={filtered()}><Link href="/tracker" class="btn btn-quiet">清除筛选</Link></Show>
        </div>
      </Toolbar>
    </form>
    <ul class="tracker-list" aria-label="追踪列表">
      <For each={props.data.wishes}>{wish => {
        const state = trackerState(wish), meta = () => [wish.author, wish.book_status === "completed" ? "" : wish.book_status_label, wish.tags.join("、")].filter(Boolean).join(" · ");
        return <li class="tracker-row" id={`wish-row-${wish.id}`}>
          <Show when={wish.library_book_id} fallback={<span class="tracker-row-cover" aria-label={`${wish.title}（${state}）`}><TrackerCover wish={wish} compact /></span>}><Link class="tracker-row-cover tracker-cover-link" href={trackerBookHref(wish, props.data.current_url)} aria-label={`打开《${wish.title}》详情（${state}）`}><TrackerCover wish={wish} compact /></Link></Show>
          <div class="tracker-row-body">
            <div class="tracker-row-heading">
              <span class="tracker-title-block"><span class="tracker-title">{wish.title}</span><span class="tracker-meta">{meta()}</span></span>
              <Menu title={wish.title} subtitle={[wish.author, wish.book_status === "completed" ? "" : wish.book_status_label].filter(Boolean).join(" · ")} class="tracker-row-menu" align="end" chevron={false} triggerLabel={`《${wish.title}》的操作${state ? `（${state}）` : ""}`}
                status={state || undefined} statusTone={state ? menuTone(wish) : undefined}
                trigger={<Icon icon={TablerDotsVertical} size={18} />}
                items={[...(wish.library_book_id ? [{ label: "在书库中打开", icon: TablerBook2, href: trackerBookHref(wish, props.data.current_url) }] : []), { label: "编辑追踪", icon: TablerPencil, onSelect: () => setActive({ wish }) }, { label: "删除追踪", icon: TablerTrash, destructive: true, onSelect: () => setDeleting(wish) }]} />
            </div>
            <div class="tracker-row-details"><Show when={wish.rating !== null}><StarRating rating={wish.rating!} /></Show><RelativeTime value={wish.updated_at} labelPrefix="更新于" clampFuture /></div>
          </div>
        </li>;
      }}</For>
    </ul>
    <Show when={!props.data.wishes.length}><EmptyState>{filtered() ? "没有符合筛选条件的书籍。" : "还没有追踪的书籍，先记下想读的第一本吧。"}</EmptyState></Show>
    <Pagination page={props.data.page} total={props.data.stats.filtered} shown={props.data.wishes.length} perPage={20} unit="本" href={props.data.current_url} />
    <CenterDialog open={Boolean(active())} title={active()?.wish ? "编辑追踪" : "添加书籍"} onClose={() => setActive(null)} class="tracker-editor"><Show when={active()} keyed>{value => <TrackerForm wish={value.wish} next={props.data.current_url} onClose={() => setActive(null)} onDelete={value.wish ? () => requestDelete(value.wish!) : undefined} />}</Show></CenterDialog>
    <ConfirmDialog open={Boolean(deleting())} title="删除追踪" danger confirmLabel="删除" onClose={() => { if (!mutation.busy()) setDeleting(null); }} onConfirm={remove}><Show when={deleting()}>{wish => <form action={`/tracker/${wish().id}/delete`} method="post" onSubmit={event => { event.preventDefault(); if (!mutation.busy()) void remove(); }}><input type="hidden" name="next" value={props.data.current_url} /><p>确定删除《{wish().title}》的追踪条目？</p></form>}</Show></ConfirmDialog>
  </div>;
}
