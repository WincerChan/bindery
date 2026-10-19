import type { Job, Metadata } from "../../core/models";
import type { LibraryStorage } from "../storage";
import { loadRuleTemplates, loadThemeTemplates } from "../templates";
export function ingestOptions() {
  return { rules: loadRuleTemplates().map(({ rule_id, name, version }) => ({ rule_id, name, version })), themes: loadThemeTemplates().map(({ theme_id, name, version }) => ({ theme_id, name, version })) };
}
export function jobActionLabel(action: string): string {
  return ({ upload: "上传并转换", "upload-epub": "EPUB 入库", "edit-writeback": "编辑并写回", regenerate: "重新生成", retry: "重试生成", ingest: "入库检查" } as Record<string, string>)[action.trim()] || action || "任务";
}
export function jobView(job: Job, index: Map<string, Metadata>) {
  const meta = index.get(job.book_id || "");
  return { ...job, book_title: meta?.title || "未关联书籍", book_author: meta?.author || "未知", can_open_book: Boolean(job.book_id && meta && !meta.archived), action_label: jobActionLabel(job.action) };
}
export function invalidJobIds(jobs: Job[], index: Map<string, Metadata>): string[] { return jobs.filter(job => !job.book_id?.trim() || !index.has(job.book_id.trim())).map(job => job.id); }
export const selectedTab = (tab: string) => ["running", "success", "failed"].includes(tab) ? tab : "running";
export function jobsPayload(library: LibraryStorage, tab = "running", page = 1) {
  const index = new Map([...library.listBooks(), ...library.listArchivedBooks()].map(meta => [meta.book_id, meta]));
  const all = library.db.listJobs(), active_tab = selectedTab(tab), filtered = all.filter(job => job.status === active_tab);
  const total_pages = Math.max(1, Math.ceil(filtered.length / 12)), selected_page = Math.min(total_pages, Math.max(1, Math.trunc(page) || 1));
  return { jobs: filtered.slice((selected_page - 1) * 12, selected_page * 12).map(job => jobView(job, index)), tabs: [{ key: "running", label: "进行中" }, { key: "success", label: "已完成" }, { key: "failed", label: "失败" }].map(tab => ({ ...tab, count: all.filter(job => job.status === tab.key).length })), active_tab, page: selected_page, total_pages, total_jobs: filtered.length, invalid_job_count: invalidJobIds(all, index).length };
}
export type JobsPayload = ReturnType<typeof jobsPayload>;
