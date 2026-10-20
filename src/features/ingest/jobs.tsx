import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { Button, Dialog, EmptyState, Pagination, Tag } from "../../ui";
import type { JobsPayload } from "../../server/ingest/queries";
export function RecentJobs(props: { data: JobsPayload; open: boolean; onOpen: () => unknown; onClose: () => unknown; navigate?: (href: string) => unknown }) {
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
    <Dialog id="jobs" variant="sheet" class="ingest-jobs-sheet" title="最近任务" closeLabel="关闭最近任务" open={props.open} onClose={() => { abort(); void props.onClose(); }}><div onClick={event => {
    if (!props.navigate || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href^="/ingest?"]');
    if (anchor) { event.preventDefault(); abort(); void props.navigate(anchor.getAttribute("href")!); }
  }}><JobsSection data={data()} /></div></Dialog>
  </>;
}
export function JobsSection(props: { data: JobsPayload }) {
  return <div id="jobs-section" class="ingest-jobs-section">
    <div class="ingest-actions"><p class="muted">当前分组共 {props.data.total_jobs} 条</p>
      <Show when={props.data.invalid_job_count > 0}><form action="/jobs/cleanup-invalid" method="post"><input type="hidden" name="tab" value={props.data.active_tab} /><Button type="submit" variant="secondary" size="sm">清空失效历史任务（{props.data.invalid_job_count}）</Button></form></Show>
    </div>
    <nav aria-label="任务分组" class="ingest-actions"><For each={props.data.tabs}>{tab => <a class={`chip ${props.data.active_tab === tab.key ? "is-selected" : ""}`} href={`/ingest?jobs_tab=${tab.key}&jobs_page=1#jobs`} aria-current={props.data.active_tab === tab.key ? "page" : undefined}>{tab.label} · {tab.count}</a>}</For></nav>
    <Show when={props.data.jobs.length} fallback={<EmptyState title="暂无任务" />}><ul class="ingest-jobs-list"><For each={props.data.jobs}>{job => <li><article class="ingest-job">
      <div class="ingest-job-identity"><Show when={job.can_open_book} fallback={<strong>{job.book_title}</strong>}><a href={`/book/${job.book_id}`}><strong>{job.book_title}</strong></a></Show><p class="muted">作者：{job.book_author}</p><p class="muted ingest-job-id">任务 ID：{job.id}</p></div>
      <div><Tag tone={job.status === "success" ? "ok" : job.status === "failed" ? "failed" : "pending"}>{job.status === "success" ? "已完成" : job.status === "failed" ? "失败" : "进行中"}</Tag> <Tag>{job.action_label}</Tag><p>{job.stage || "—"} · {job.rule_template || "—"}</p></div>
      <time datetime={job.created_at} class="muted">{job.created_at}</time>
      <div class="ingest-actions"><Show when={job.can_open_book}><a class="btn btn-secondary btn-sm" href={`/book/${job.book_id}`}>打开产物</a></Show><Show when={job.status === "failed" && job.book_id}><form action={`/jobs/${encodeURIComponent(job.id)}/retry`} method="post"><Button variant="secondary" size="sm" type="submit">一键重试</Button></form></Show></div>
      <Show when={job.message}><p class="ingest-job-message muted">{job.message}</p></Show>
      <Show when={job.log}><details class="ingest-job-log"><summary>展开详细日志</summary><pre>{job.log}</pre></details></Show>
    </article></li>}</For></ul></Show>
    <Pagination page={props.data.page} total={props.data.total_jobs} perPage={12} href={`/ingest?jobs_tab=${props.data.active_tab}#jobs`} pageParam="jobs_page" />
  </div>;
}
