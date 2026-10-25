import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { Button, Dialog, EmptyState, Pagination, Tag } from "../../ui";
import { Link } from "../../shared/spa-link";
import { useMutation } from "../../shared/client-mutation";
import { cleanupInvalidJobs, retryJob } from "./mutations";
import type { JobsPayload } from "../../server/ingest/queries";
export function RecentJobs(props: { data: JobsPayload; open: boolean; onOpen: () => unknown; onClose: () => unknown }) {
  const [data, setData] = createSignal<JobsPayload>(untrack(() => props.data));
  const source = createMemo(() => props.data), opened = createMemo(() => props.open);
  let controller: AbortController | undefined;
  const abort = () => { controller?.abort(); controller = undefined; };
  const running = () => data().tabs.find(tab => tab.key === "running")?.count || 0;
  createEffect(source, value => { abort(); setData(value); });
  createEffect(opened, open => {
    if (!open || typeof window === "undefined") return;
    const timer = setInterval(async () => {
      if (document.hidden || controller) return;
      const current = new AbortController(); controller = current;
      const tab = data().active_tab, page = data().page;
      try {
        const response = await fetch(`/jobs/partial?tab=${tab}&page=${page}`, { headers: { Accept: "application/json" }, signal: current.signal });
        if (response.ok) {
          const value: JobsPayload = await response.json();
          if (!current.signal.aborted && tab === data().active_tab && page === data().page) setData(value);
        }
      } catch (error) { if (!current.signal.aborted) console.error(error); }
      finally { if (controller === current) controller = undefined; }
    }, 5000);
    return () => { clearInterval(timer); abort(); };
  });
  return <>
    <Button variant="secondary" aria-haspopup="dialog" aria-controls="jobs" aria-expanded={props.open ? "true" : "false"} onClick={() => void props.onOpen()}>最近任务{running() ? ` · ${running()}` : ""}</Button>
    <Dialog id="jobs" variant="sheet" class="ingest-jobs-sheet" title="最近任务" closeLabel="关闭最近任务" open={props.open} onClose={() => { abort(); void props.onClose(); }}><JobsSection data={data()} /></Dialog>
  </>;
}
export function JobsSection(props: { data: JobsPayload }) {
  const mutation = useMutation();
  const refresh = () => mutation.router.invalidate();
  return <div id="jobs-section" class="ingest-jobs-section">
    <Show when={props.data.invalid_job_count > 0}><div class="ingest-actions ingest-jobs-summary"><form action="/jobs/cleanup-invalid" method="post" onSubmit={event => { event.preventDefault(); void mutation.run(() => cleanupInvalidJobs({ data: props.data.active_tab }), refresh, "已清空失效历史任务"); }}><input type="hidden" name="tab" value={props.data.active_tab} /><Button type="submit" variant="secondary" size="sm" disabled={mutation.busy()}>清空失效历史任务（{props.data.invalid_job_count}）</Button></form></div></Show>
    <nav aria-label="任务分组" class="ingest-job-tabs"><For each={props.data.tabs}>{tab => <Link replace resetScroll={false} hashScrollIntoView={false} class={`chip ${props.data.active_tab === tab.key ? "is-selected" : ""}`} href={`/ingest?jobs_tab=${tab.key}&jobs_page=1#jobs`} aria-current={props.data.active_tab === tab.key ? "page" : undefined}>{tab.label} · {tab.count}</Link>}</For></nav>
    <Show when={props.data.jobs.length} fallback={<EmptyState title="暂无任务" />}><ul class="ingest-jobs-list"><For each={props.data.jobs}>{job => <li><article class="ingest-job">
      <header class="ingest-job-heading">
        <div class="ingest-job-identity"><Show when={job.can_open_book} fallback={<strong>{job.book_title}</strong>}><Link href={`/book/${job.book_id}`}><strong>{job.book_title}</strong></Link></Show><p class="muted">作者：{job.book_author}</p></div>
        <time datetime={job.created_at} class="muted">{job.created_at}</time>
      </header>
      <div class="ingest-job-status"><div class="ingest-job-tags"><Tag tone={job.status === "success" ? "ok" : job.status === "failed" ? "failed" : "pending"}>{job.status === "success" ? "已完成" : job.status === "failed" ? "失败" : "进行中"}</Tag><Tag>{job.action_label}</Tag></div><p class="muted">{job.stage || "—"} · {job.rule_template || "—"}</p></div>
      <footer class="ingest-job-footer"><p class="muted ingest-job-id">任务 ID：{job.id}</p><div class="ingest-actions"><Show when={job.can_open_book}><Link class="btn btn-secondary btn-sm" href={`/book/${job.book_id}`}>打开产物</Link></Show><Show when={job.status === "failed" && job.book_id}><form action={`/jobs/${encodeURIComponent(job.id)}/retry`} method="post" onSubmit={event => { event.preventDefault(); void mutation.run(() => retryJob({ data: job.id }), refresh, "已创建重试任务"); }}><Button variant="secondary" size="sm" type="submit" disabled={mutation.busy()}>一键重试</Button></form></Show></div></footer>
      <Show when={job.message && job.message !== job.stage}><p class="ingest-job-message muted">{job.message}</p></Show>
      <Show when={job.log}><details class="ingest-job-log"><summary>展开详细日志</summary><pre>{job.log}</pre></details></Show>
    </article></li>}</For></ul></Show>
    <Pagination page={props.data.page} total={props.data.total_jobs} shown={props.data.jobs.length} perPage={12} unit="项" href={`/ingest?jobs_tab=${props.data.active_tab}#jobs`} pageParam="jobs_page" replace resetScroll={false} hashScrollIntoView={false} />
  </div>;
}
