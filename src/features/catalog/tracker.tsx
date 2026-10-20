import { createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Button, ConfirmDialog, Dialog, EmptyState, Pagination, Select, Tag, Textarea, TextField } from "../../ui";
import type { DuplicateData, TrackerItem, TrackerPageData } from "../../server/catalog/tracker";
import { isRedirect } from "@tanstack/solid-router";
import { Link } from "../../shared/spa-link";
import { formFields, useMutation } from "../../shared/client-mutation";
import { showToast } from "../../client/toast";
import { checkTracker, deleteTracker, saveTracker } from "./mutations";

function ReadOptions() { return <><option value="unread">未读</option><option value="reading">在读</option><option value="read">已读</option></>; }
function StatusOptions() { return <><option value="ongoing">更新中</option><option value="hiatus">已断更</option><option value="completed">已完结</option></>; }
export function TrackerForm(props: { wish?: TrackerItem; next: string; onClose: () => void }) {
  const mutation = useMutation();
  const [title, setTitle] = createSignal(untrack(() => props.wish?.title || "")), [author, setAuthor] = createSignal(untrack(() => props.wish?.author || ""));
  const [duplicates, setDuplicates] = createSignal<DuplicateData | null>(null), [checking, setChecking] = createSignal(false), [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  let timeout: ReturnType<typeof setTimeout> | undefined, abort: AbortController | undefined, sequence = 0;
  onCleanup(() => { clearTimeout(timeout); abort?.abort(); sequence++; });
  function check() {
    if (props.wish) return;
    clearTimeout(timeout); abort?.abort(); const current = ++sequence;
    setDuplicates(null); setChecking(Boolean(title().trim()));
    if (!title().trim()) return;
    timeout = setTimeout(async () => {
      abort = new AbortController();
      try { const data = await checkTracker({ data: { title: title(), author: author() }, signal: abort.signal }); if (current === sequence) { setDuplicates(data); setError(""); } }
      catch (error) { if (isRedirect(error)) { await mutation.router.navigate({ href: error.options.href || "/login" }); return; } if (current === sequence && !abort.signal.aborted) { const message = error instanceof Error ? error.message : "检查失败"; setError(message); showToast(message, "error"); } }
      finally { if (current === sequence) setChecking(false); }
    }, 250);
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (busy()) return; setBusy(true); setError("");
    const fields = formFields(event.currentTarget as HTMLFormElement);
    try {
      await mutation.run(() => saveTracker({ data: { id: props.wish?.id, fields } }), async result => {
        props.onClose(); await mutation.router.navigate({ href: result.target }); await mutation.router.invalidate();
      }, "已保存追踪");
    } finally { setBusy(false); }
  }
  return <form action={props.wish ? `/tracker/${props.wish.id}/update` : "/tracker"} method="post" onSubmit={submit} class="catalog-tracker-form">
    <input type="hidden" name="next" value={props.next} /><input type="hidden" name="library_book_id" value={props.wish?.library_book_id || ""} />
    <TextField name="title" label="书名" value={title()} required readonly={Boolean(props.wish?.library_book_id)} onInput={event => { setTitle(event.currentTarget.value); check(); }} />
    <TextField name="author" label="作者" value={author()} readonly={Boolean(props.wish?.library_book_id)} onInput={event => { setAuthor(event.currentTarget.value); check(); }} />
    <Show when={props.wish?.library_book_id}><p class="catalog-wide muted">已入库条目的书名/作者由书库元数据维护</p></Show>
    <Show when={duplicates()}><div class="catalog-wide" aria-live="polite">
      <Show when={duplicates()?.exists} fallback={<><p>已添加项目（共 {duplicates()?.matches.length || 0} 条）：</p><ul class="catalog-tracker-suggestions"><For each={duplicates()?.matches || []}>{item => <li><Link href={`/tracker?duplicate=${item.id}`}>{item.title} · {item.author || "未知作者"} · 点此前往编辑</Link></li>}</For></ul></>}>
        <p>已存在追踪条目</p><For each={duplicates()?.blocking_matches || []}>{item => <p><Link href={`/tracker?duplicate=${item.id}`}>{item.title} · {item.author || "未知作者"} · 点此前往编辑该条目。</Link></p>}</For>
      </Show>
    </div></Show>
    <TextField name="tags" label="标签" value={props.wish?.tags_text || ""} hint="用逗号分隔" />
    <Select name="rating" label="评分" value={props.wish?.rating == null ? "" : String(props.wish.rating)}><option value="">未评分</option><For each={[5, 4, 3, 2, 1]}>{n => <option value={String(n)}>{n} 星</option>}</For></Select>
    <Select name="read_status" label="阅读状态" value={props.wish?.read_status || "unread"}><ReadOptions /></Select>
    <Select name="book_status" label="状态" value={props.wish?.book_status || "completed"}><StatusOptions /></Select>
    <Textarea class="catalog-wide" name="comment" label="评论" rows={4} placeholder="评论" value={props.wish?.comment || ""} />
    <Show when={error()}><p class="catalog-wide field-error" role="alert">{error()}</p></Show>
    <div class="catalog-actions"><Button type="submit" disabled={busy() || checking() || Boolean(duplicates()?.exists)}>{busy() ? "保存中…" : checking() ? "检查中…" : props.wish ? "保存更改" : "保存到追踪"}</Button><Button variant="secondary" onClick={props.onClose}>取消</Button></div>
  </form>;
}
export function TrackerPage(props: { data: TrackerPageData }) {
  const mutation = useMutation();
  const [active, setActive] = createSignal<{ wish?: TrackerItem } | null>(null), [deleting, setDeleting] = createSignal<TrackerItem | null>(null);
  async function remove() {
    await mutation.run(() => deleteTracker({ data: { id: deleting()!.id, next: props.data.current_url } }), async result => {
      setDeleting(null); await mutation.router.navigate({ href: result.target }); await mutation.router.invalidate();
    }, "已删除追踪", true);
  }
  return <div class="catalog-page catalog-tracker"><div class="catalog-heading"><h1>追踪</h1><div class="catalog-actions"><a class="btn btn-secondary" href={props.data.export_url}>导出 CSV</a><Button onClick={() => setActive({})}>添加书籍</Button></div></div>
    <p class="muted">共 {props.data.stats.total} 本 · 未读 {props.data.stats.unread} · 在读 {props.data.stats.reading} · 已读 {props.data.stats.read} · 已入库 {props.data.stats.in_library}</p>
    <Show when={props.data.duplicate_notice}><div class="catalog-tracker-notice" role="status"><p>已存在追踪条目：{props.data.duplicate_notice?.title}</p><Button variant="secondary" onClick={() => setActive({ wish: props.data.duplicate_notice! })}>点此前往编辑该条目。</Button></div></Show>
    <form action="/tracker" method="get" class="catalog-tracker-filter" onSubmit={event => {
      event.preventDefault(); const search = formFields(event.currentTarget); void mutation.router.navigate({ to: "/tracker", search });
    }}>
      <TextField name="q" label="搜索" type="search" value={props.data.filters.q} placeholder="搜索书名、作者、标签" />
      <Select name="read_filter" label="阅读" value={props.data.filters.read_filter}><option value="all">全部</option><ReadOptions /></Select>
      <Select name="library_filter" label="书库" value={props.data.filters.library_filter}><option value="all">全部</option><option value="in">已入库</option><option value="out">未入库</option></Select>
      <Select name="book_status_filter" label="状态" value={props.data.filters.book_status_filter}><option value="all">全部</option><StatusOptions /></Select>
      <div class="catalog-actions"><Button type="submit" variant="secondary">筛选</Button><Link href="/tracker" class="btn btn-quiet">重置</Link></div>
    </form>
    <div class="catalog-tracker-rows"><For each={props.data.wishes}>{wish => <article class="catalog-tracker-row" id={`wish-row-${wish.id}`}>
      <div><h2>{wish.title}</h2><p class="muted">{wish.author || "未知作者"}</p><div class="catalog-tracker-meta"><Tag>{wish.book_status_label}</Tag><Tag tone={wish.read ? "ok" : "neutral"}>{wish.read_status_label}</Tag><Tag>{wish.exists_label}</Tag></div><Show when={wish.tags_text}><p>{wish.tags_text}</p></Show><Show when={wish.comment}><p>{wish.comment}</p></Show></div>
      <div><p>评分：{wish.rating === null ? "未评分" : `${wish.rating} / 5`}</p><p class="muted">更新时间 {wish.updated_at_display}</p></div>
      <div class="catalog-actions"><Show when={wish.library_book_id}><Link class="btn btn-secondary btn-sm" aria-label="查看详情" href={`/book/${wish.library_book_id}?return_to=${encodeURIComponent(props.data.current_url)}`}>详情 ↗</Link></Show><Button size="sm" variant="secondary" onClick={() => setActive({ wish })}>编辑追踪</Button><form action={`/tracker/${wish.id}/delete`} method="post" onSubmit={event => { event.preventDefault(); setDeleting(wish); }}><input type="hidden" name="next" value={props.data.current_url} /><Button type="submit" size="sm" variant="danger">删除</Button></form></div>
    </article>}</For></div>
    <Show when={!props.data.wishes.length}><EmptyState>没有符合筛选条件的书籍。</EmptyState></Show>
    <p class="muted">第 {props.data.page} / {props.data.total_pages} 页</p><Pagination page={props.data.page} total={props.data.stats.filtered} perPage={20} href={props.data.current_url} />
    <Dialog open={Boolean(active())} title={active()?.wish ? "编辑追踪" : "添加追踪"} onClose={() => setActive(null)} class="catalog-page"><Show when={active()} keyed>{value => <TrackerForm wish={value.wish} next={props.data.current_url} onClose={() => setActive(null)} />}</Show></Dialog>
    <ConfirmDialog open={Boolean(deleting())} title="删除追踪" danger confirmLabel="删除" onClose={() => { if (!mutation.busy()) setDeleting(null); }} onConfirm={remove}><p>确定删除《{deleting()?.title}》的追踪条目？</p></ConfirmDialog>
  </div>;
}
