import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { BackgroundActivityPill, Button, ConfirmDialog, EmptyState, GeneratedCover, IconButton, Pagination, SideSheet } from "../../ui";
import { IngestJobTabs, IngestJobTime } from "./local-job-controls";
import { Link } from "../../shared/spa-link";
import { useMutation } from "../../shared/client-mutation";
import { cleanupInvalidJobs, retryJob } from "./mutations";
import type { JobsPayload } from "../../server/ingest/queries";
export function RecentJobs(props: { data: JobsPayload; open: boolean; onOpen: () => unknown; onClose: () => unknown; layout?: (trigger: JSX.Element, sheet: JSX.Element) => JSX.Element }) {
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
  const trigger = <BackgroundActivityPill count={running() ? `${running()} 进行中` : undefined} aria-haspopup="dialog" aria-controls="jobs" aria-expanded={props.open ? "true" : "false"} onClick={() => void props.onOpen()}>最近任务</BackgroundActivityPill>;
  const sheet = <SideSheet id="jobs" class="ingest-jobs-sheet" title="最近任务" closeLabel="关闭最近任务" open={props.open} onClose={() => { abort(); void props.onClose(); }}><JobsSection data={data()} /></SideSheet>;
  return props.layout ? props.layout(trigger, sheet) : <>{trigger}{sheet}</>;
}
export function JobsSection(props: { data: JobsPayload }) {
  const mutation = useMutation();
  const refresh = () => mutation.router.invalidate();
  const [cleanupOpen, setCleanupOpen] = createSignal(false);
  return <div id="jobs-section" class="ingest-jobs-section">
    <IngestJobTabs data={props.data} />
    <Show when={props.data.jobs.length} fallback={<EmptyState title="暂无任务" />}><ul class="ingest-jobs-list"><For each={props.data.jobs}>{job => <li><article class="ingest-job">
      <header class="ingest-job-heading">
        <GeneratedCover compact book_id={job.book_id || job.id} title={job.book_title} state={job.status === "failed" ? "failed" : job.status === "success" ? undefined : "generating"} />
        <div class="ingest-job-identity"><Show when={job.can_open_book} fallback={<strong>{job.book_title}</strong>}><Link href={`/book/${job.book_id}`}><strong>{job.book_title}</strong></Link></Show><p><Show when={job.book_author}>{job.book_author} · </Show><IngestJobTime value={job.created_at} /></p><Show when={job.status === "failed" && job.message && job.message !== job.stage}><p class="ingest-job-error">{job.message}</p></Show></div>
        <Show when={job.status === "failed" && job.book_id}><form action={`/jobs/${encodeURIComponent(job.id)}/retry`} method="post" onSubmit={event => { event.preventDefault(); void mutation.run(() => retryJob({ data: job.id }), refresh, "已创建重试任务"); }}><IconButton type="submit" aria-label={`重试《${job.book_title}》`} title="一键重试" disabled={mutation.busy()}>↻</IconButton></form></Show>
      </header>
      <details class="ingest-job-log"><summary>展开详细日志</summary><p>{job.status === "success" ? "已完成" : job.status === "failed" ? "失败" : "进行中"} · {job.action_label}</p><Show when={job.stage}><p>{job.stage}</p></Show><Show when={job.rule_template}><p>切章规则：{job.rule_template}</p></Show><p class="ingest-job-id">任务 ID：{job.id}</p><Show when={job.status !== "failed" && job.message && job.message !== job.stage}><p>{job.message}</p></Show><Show when={job.can_open_book}><Link class="ingest-job-output" href={`/book/${job.book_id}`}>打开产物</Link></Show><Show when={job.log}><pre>{job.log}</pre></Show></details>
    </article></li>}</For></ul></Show>
    <Show when={props.data.invalid_job_count > 0}><form action="/jobs/cleanup-invalid" method="post" onSubmit={event => { event.preventDefault(); setCleanupOpen(true); }}><input type="hidden" name="tab" value={props.data.active_tab} /><Button type="submit" variant="quiet" disabled={mutation.busy()}>清空失效历史任务（{props.data.invalid_job_count}）</Button></form></Show>
    <ConfirmDialog open={cleanupOpen()} title="清空失效历史任务？" confirmLabel="确认清空" danger onClose={() => setCleanupOpen(false)} onConfirm={() => mutation.run(() => cleanupInvalidJobs({ data: props.data.active_tab }), refresh, "已清空失效历史任务")}><p>只移除已失效的任务记录，不会删除书籍。</p></ConfirmDialog>
    <Pagination page={props.data.page} total={props.data.total_jobs} shown={props.data.jobs.length} perPage={12} unit="项" href={`/ingest?jobs_tab=${props.data.active_tab}#jobs`} pageParam="jobs_page" replace resetScroll={false} hashScrollIntoView={false} />
  </div>;
}
