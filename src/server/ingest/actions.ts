import { validateCss } from "../../core/css";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LibraryStorage } from "../storage";
import { newBookId } from "../storage";
import { enqueueJob } from "../jobs";
import { HttpError, requireEntity, missingEntity, requireBook, redirectWithToast } from "../http";
import { effectiveThemeId } from "../book-view";
import { loadRuleTemplates, loadThemeTemplates } from "../templates";
import { nowIso } from "../db";
import { cleanupStagedExcept, cleanupStaged, loadStaged, normalizeTokens, persistUpload, queueDirectory, type UploadFile } from "./staging";
import { emptyFields, fieldNames, type UploadSpec } from "./processor";
import { invalidJobIds, selectedTab } from "./queries";

export const formText = (form: FormData, name: string, fallback = "") => typeof form.get(name) === "string" ? form.get(name) as string : fallback;
export function formFiles(form: FormData, name: string): File[] { return form.getAll(name).filter((v): v is File => typeof v !== "string" && Boolean(v.name)); }
export async function submitUploads(library: LibraryStorage, form: FormData, request?: Request): Promise<Response | { error: string; custom_css: string }> {
  const files = formFiles(form, "files"), tokens = normalizeTokens(form.getAll("upload_tokens"));
  if (!files.length && !tokens.length) throw new HttpError(400, "Empty file");
  const fields = emptyFields(); for (const field of fieldNames) fields[field] = formText(form, field, fields[field]);
  const cssError = validateCss(fields.custom_css);
  if (cssError) return { error: `自定义 CSS 校验失败：${cssError}`, custom_css: fields.custom_css };
  cleanupStagedExcept(library, tokens);
  const staged = tokens.map(token => loadStaged(library, token)).filter(e => e !== null);
  if (tokens.length && !staged.length) return { error: "上传暂存已失效，请重新选择文件后再提交。", custom_css: fields.custom_css };
  const keep = new Set(normalizeTokens(form.getAll("dedupe_keep_tokens"))), cover = formFiles(form, "cover_file")[0];
  const coverBytes = cover ? Buffer.from(await cover.arrayBuffer()) : null;
  let queued = 0, failed = 0;
  const entries: Array<{ file?: UploadFile; staged?: typeof staged[number] }> = [...staged.map(staged => ({ staged })), ...files.map(file => ({ file }))];
  for (const input of entries) {
    const id = newBookId(), directory = queueDirectory(library, id); let published = false;
    try {
      mkdirSync(directory, { recursive: true });
      let entry: Omit<typeof staged[number], "token">;
      if (input.staged) {
        const { token: _token, ...value } = input.staged;
        entry = { ...value, payload_path: join(directory, value.payload_name) }; copyFileSync(value.payload_path, entry.payload_path);
      } else entry = await persistUpload(input.file!, directory);
      const action = entry.kind === "txt" ? "upload" : entry.kind === "epub" ? "upload-epub" : "ingest";
      const book_id = entry.kind === "unknown" ? null : newBookId();
      if (!entry.size) {
        const now = nowIso();
        library.db.createJob({ id, book_id: input.staged ? null : book_id, action: input.staged ? "ingest" : action, status: "failed", stage: "失败", message: `${entry.filename}: 空文件`, log: null, rule_template: entry.kind === "epub" ? null : fields.rule_template, created_at: now, updated_at: now });
        continue;
      }
      if (coverBytes?.length) writeFileSync(join(directory, "cover"), coverBytes);
      const spec: UploadSpec = { version: 1, filename: entry.filename, content_type: entry.content_type, payload_name: entry.payload_name, fields, dedupe_mode: input.staged && keep.has(input.staged.token) ? "keep" : formText(form, "dedupe_mode") === "normalize" ? "normalize" : "keep", cover_name: cover?.name || null };
      // The complete descriptor and files exist before the durable jobs row becomes visible.
      writeFileSync(join(directory, "task.json"), JSON.stringify(spec));
      JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
      const result = enqueueJob({ id, book_id, action, rule_template: entry.kind === "epub" ? null : fields.rule_template }, library);
      published = result.queued;
      if (result.queued) queued++; else failed++;
    } finally {
      if (!published) rmSync(directory, { recursive: true, force: true });
      if (input.staged) cleanupStaged(library, input.staged.token);
    }
  }
  const message = queued > 0 ? `已创建 ${queued} 个任务，可继续上传下一本。` : failed > 0 ? "任务创建失败，请稍后重试或前往任务页查看详情。" : "本次未创建任务。";
  const response = redirectWithToast("/ingest", message, queued > 0 ? "success" : failed > 0 ? "error" : "warning");
  if (request?.headers.get("HX-Request") === "true") return new Response(null, { status: 200, headers: { "HX-Redirect": response.headers.get("Location")! } });
  return response;
}
export function regenerateBook(library: LibraryStorage, id: string, form: FormData, retryId?: string): Response {
  let bookId = id;
  if (retryId) { const job = library.db.getJob(retryId); bookId = requireEntity(job?.book_id, "job"); }
  const meta = requireBook(bookId, library);
  if (meta.source_type === "epub") throw new HttpError(400, retryId ? "EPUB 导入的书籍无法重试生成" : "EPUB 导入的书籍无法重新生成");
  enqueueJob({ book_id: bookId, rule_template: formText(form, "rule_template", "default"), action: retryId ? "retry" : "regenerate" }, library);
  return new Response(null, { status: 303, headers: { Location: "/jobs?tab=running" } });
}
export function regenerateBulk(library: LibraryStorage, form: FormData): Response {
  const themes = formText(form, "scope", "parsing").trim().toLowerCase() === "themes", template = formText(form, "template_id").trim() || "default";
  if (themes ? !loadThemeTemplates().some(t => t.theme_id === template) : !loadRuleTemplates().some(t => t.rule_id === template)) missingEntity(themes ? "theme" : "rule");
  let count = 0;
  for (const meta of library.listBooks()) {
    const rule = meta.rule_template?.trim() || "default";
    if (themes ? effectiveThemeId(meta) !== template : rule !== template || meta.source_type === "epub") continue;
    if (enqueueJob({ book_id: meta.book_id, rule_template: themes && meta.source_type === "epub" ? meta.rule_template : rule, action: themes && meta.source_type === "epub" ? "edit-writeback" : "regenerate" }, library).queued) count++;
  }
  const location = count ? "/jobs?tab=running" : `/rules?tab=${themes ? "themes" : "parsing"}&${themes ? "theme_id" : "rule_id"}=${encodeURIComponent(template)}&error=${encodeURIComponent("没有匹配的书籍可批量处理")}`;
  return new Response(null, { status: 303, headers: { Location: location } });
}
export function cleanupInvalid(library: LibraryStorage, tab: string): Response {
  const index = new Map([...library.listBooks(), ...library.listArchivedBooks()].map(m => [m.book_id, m]));
  const ids = invalidJobIds(library.db.listJobs(), index);
  library.db.deleteJobs(ids);
  for (const id of ids) if (/^[a-f0-9]{32}$/.test(id)) rmSync(queueDirectory(library, id), { recursive: true, force: true });
  return new Response(null, { status: 303, headers: { Location: `/jobs?tab=${selectedTab(tab)}` } });
}
