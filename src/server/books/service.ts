import type { EditWritebackOptions } from "../ingest/edit-staging";
import { ensureTrackerForBook as ensureTracker, ensureTrackerConsistencyForMeta, applyTrackerStateToMetadataCache } from "../tracker";
import type { Metadata, Wish } from "../../core/models";
import { bookView, type BookView } from "../book-view";
import { requireBook, HttpError } from "../http";
import { nowIso } from "../db";
import type { LibraryStorage } from "../storage";
import { loadRuleTemplates, loadThemeTemplates } from "../templates";
import { enqueueEditWriteback } from "../jobs";
import { strip } from "../../core/text";
import { validateCss } from "../../core/css";
import { bookNavigation } from "../../features/books/navigation";
import {
  lookupBookMetadataCandidates,
  type LookupMetadata,
  type Fetch,
  type LookupAttempt,
} from "./metadata-lookup";
import { uploadedCover } from "./covers";

export type BookDraft = BookView & { cover_fetch_url?: string };
export interface BookPage {
  book: BookDraft;
  navigation: ReturnType<typeof bookNavigation>;
  rules: { rule_id: string; name: string; version: string }[];
  themes: { theme_id: string; name: string; version: string }[];
  strip_original_css: boolean;
  strip_fonts: boolean;
  error?: string;
  info?: string;
  lookup_attempts?: LookupAttempt[];
  lookup_changed_fields?: string[];
  lookup_selected_source?: string;
  lookup_candidates?: Record<string, LookupMetadata>;
  lookup_allow_cover_fill?: boolean;
  lookup_result?: ReturnType<typeof lookupResultView>;
}
export const textField = (form: FormData, name: string) =>
  typeof form.get(name) === "string" ? String(form.get(name)) : "";
export const trueFlag = (raw: string) =>
  ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
export const parseTags = (raw: string) =>
  raw
    .split(/[，,]/)
    .map((s) => s.trim())
    .filter(Boolean);
export function parseRating(raw: string): number | null {
  raw = raw.trim();
  return /^[+-]?\d+$/.test(raw) ? Math.max(0, Math.min(5, Number(raw))) : null;
}
export { ensureTrackerForBook as ensureTracker } from "../tracker";
export function syncTracker(meta: Metadata, wish: Wish, library: LibraryStorage): void {
  if (applyTrackerStateToMetadataCache(meta, wish)) library.saveMetadata(meta);
}
export function loadBookPage(
  id: string,
  returnTo: unknown,
  library: LibraryStorage,
): BookPage {
  const meta = requireBook(id, library),
    tracker = ensureTrackerConsistencyForMeta(meta, library);
  return {
    book: bookView(meta, library, tracker),
    navigation: bookNavigation(id, returnTo),
    rules: loadRuleTemplates().map(({ rule_id, name, version }) => ({
      rule_id,
      name,
      version,
    })),
    themes: loadThemeTemplates().map(({ theme_id, name, version }) => ({
      theme_id,
      name,
      version,
    })),
    strip_original_css: false,
    strip_fonts: false,
  };
}
function applyFields(meta: Metadata, form: FormData): void {
  meta.title = textField(form, "title").trim() || meta.title || "未命名";
  for (const key of [
    "author",
    "description",
    "series",
    "publisher",
    "published",
    "isbn",
  ] as const)
    meta[key] = textField(form, key).trim() || null;
  meta.language = textField(form, "language").trim() || "zh-CN";
  if (form.has("identifier"))
    meta.identifier = textField(form, "identifier").trim() || null;
  meta.tags = parseTags(textField(form, "tags"));
  meta.rating = parseRating(textField(form, "rating"));
}
function applyBuildSettings(meta: Metadata, form: FormData): void {
  if (meta.source_type !== "epub")
    meta.rule_template =
      textField(form, "rule_template").trim() ||
      meta.rule_template ||
      "default";
  const theme = textField(form, "theme_template").trim();
  meta.theme_template =
    meta.source_type === "epub" && theme === "__book__"
      ? "__book__"
      : theme && theme !== "__book__"
        ? theme
        : "default";
  meta.custom_css = strip(textField(form, "custom_css")) || null;
}
export function buildEditDraft(page: BookPage, form: FormData): BookDraft {
  const draft = { ...page.book, tags: [...page.book.tags] };
  applyFields(draft, form);
  draft.custom_css = strip(textField(form, "custom_css")) || null;
  draft.cover_fetch_url = textField(form, "cover_url").trim();
  if (draft.source_type !== "epub")
    draft.rule_template =
      textField(form, "rule_template").trim() ||
      draft.rule_template ||
      "default";
  if (textField(form, "theme_template").trim()) {
    applyBuildSettings(draft, form);
    draft.effective_theme_template =
      draft.source_type === "epub" && draft.theme_template === "__book__"
        ? null
        : draft.theme_template;
  }
  return draft;
}
export function applyLookupMetadataToDraft(
  draft: BookDraft,
  result: LookupMetadata,
  allowCoverFill: boolean,
): string[] {
  const changed: string[] = [];
  for (const key of [
    "title",
    "author",
    "language",
    "description",
    "publisher",
    "published",
    "isbn",
  ] as const) {
    const value = result[key];
    if (value && draft[key] !== value) {
      draft[key] = value;
      changed.push(key);
    }
  }
  if (
    result.tags.length &&
    JSON.stringify(draft.tags) !== JSON.stringify(result.tags)
  ) {
    draft.tags = [...result.tags];
    changed.push("tags");
  }
  if (
    allowCoverFill &&
    result.source === "douban" &&
    result.cover_url &&
    (draft.cover_fetch_url || "").trim() !== result.cover_url.trim()
  ) {
    draft.cover_fetch_url = result.cover_url.trim();
    changed.push("cover_url");
  }
  return changed;
}
export function lookupResultView(
  query: string,
  source: string,
  draft: Partial<BookDraft>,
  errors: string[],
  source_cover_url: string | null = null,
) {
  return {
    query,
    source,
    title: draft.title,
    author: draft.author,
    language: draft.language,
    publisher: draft.publisher,
    published: draft.published,
    isbn: draft.isbn,
    cover_url: source_cover_url,
    applied_cover_url: draft.cover_fetch_url,
    tags: [...(draft.tags || [])],
    description: draft.description,
    errors: errors.slice(0, 2),
  };
}
export async function fetchBookMetadata(
  id: string,
  form: FormData,
  library: LibraryStorage,
  fetcher: Fetch = fetch,
): Promise<BookPage> {
  const page = loadBookPage(id, textField(form, "return_to"), library),
    draft = buildEditDraft(page, form);
  page.book = draft;
  page.strip_original_css = trueFlag(textField(form, "strip_original_css"));
  page.strip_fonts = trueFlag(textField(form, "strip_fonts"));
  const query = draft.title.trim(),
    result = await lookupBookMetadataCandidates(query, {
      author: draft.author,
      fetch: fetcher,
    });
  page.lookup_attempts = result.attempts;
  page.lookup_candidates = result.candidates;
  page.lookup_changed_fields = [];
  page.lookup_allow_cover_fill = false;
  page.lookup_selected_source = "";
  const source = textField(form, "metadata_source").trim().toLowerCase(),
    selected =
      (Object.hasOwn(result.candidates, source)
        ? result.candidates[source]
        : undefined) ||
      (result.best_source ? result.candidates[result.best_source] : undefined);
  if (!selected) {
    page.error = `未能从豆瓣获取元数据：${result.errors.length ? result.errors.slice(0, 2).join("；") : "未返回可用结果"}`;
    return page;
  }
  page.lookup_selected_source = selected.source;
  page.lookup_allow_cover_fill = !(
    draft.cover_file ||
    draft.cover_url ||
    draft.cover_fetch_url?.trim()
  );
  page.lookup_changed_fields = applyLookupMetadataToDraft(
    draft,
    selected,
    page.lookup_allow_cover_fill,
  );
  const name = selected.source === "douban" ? "豆瓣" : selected.source;
  page.info = `已从 ${name} 自动填充字段，请检查后再保存并写回。${page.lookup_changed_fields.includes("cover_url") ? "（已回填豆瓣封面 URL）" : ""}${result.errors.length ? "（另一个来源返回失败）" : ""}`;
  page.lookup_result = lookupResultView(
    query,
    name,
    draft,
    result.errors,
    selected.cover_url,
  );
  return page;
}
/** Integration contract: C must durably preserve these options before publishing. */
export type { EditWritebackOptions } from "../ingest/edit-staging";
export type SubmitEditWriteback = (
  meta: Metadata,
  options: EditWritebackOptions,
  library: LibraryStorage,
) => Promise<{ queued: boolean }> | { queued: boolean };
const submitEditWriteback: SubmitEditWriteback = (meta, options, library) => enqueueEditWriteback({
  book_id: meta.book_id, rule_template: meta.rule_template, ...options,
}, library);
export async function saveBookEdit(
  id: string,
  form: FormData,
  library: LibraryStorage,
  submit: SubmitEditWriteback = submitEditWriteback,
) {
  const page = loadBookPage(id, textField(form, "return_to"), library),
    meta = requireBook(id, library);
  applyFields(meta, form);
  page.strip_original_css = trueFlag(textField(form, "strip_original_css"));
  page.strip_fonts = trueFlag(textField(form, "strip_fonts"));
  const error = validateCss(textField(form, "custom_css"));
  if (error) {
    meta.custom_css = strip(textField(form, "custom_css")) || null;
    page.book = { ...bookView(meta, library), rating: meta.rating };
    page.error = `自定义 CSS 校验失败：${error}`;
    return { page };
  }
  applyBuildSettings(meta, form);
  const rawUpload = form.get("cover_file"),
    upload = rawUpload instanceof File && rawUpload.name ? rawUpload : null;
  if (upload && !upload.size) {
    page.book = { ...bookView(meta, library), rating: meta.rating };
    page.error = "封面文件为空";
    return { page };
  }
  const options: EditWritebackOptions = {
    cover_bytes: upload ? await uploadedCover(upload) : null,
    cover_name: upload?.name || null,
    cover_url: textField(form, "cover_url").trim(),
    strip_original_css: page.strip_original_css,
    strip_fonts: page.strip_fonts,
  };
  meta.status = "dirty";
  meta.updated_at = nowIso();
  library.saveMetadata(meta);
  const tracker = ensureTracker(meta, library);
  if (tracker.rating !== meta.rating)
    library.db.updateWish(tracker.id, {
      rating: meta.rating,
      updated_at: nowIso(),
    });
  const { queued } = await submit(meta, options, library);
  return {
    page: { ...page, book: bookView(meta, library) },
    queued,
    message: queued
      ? "已创建写回任务，可继续编辑下一本。"
      : "写回任务创建失败，请稍后重试或在入库页的「最近任务」中查看详情。",
    kind: queued ? ("success" as const) : ("error" as const),
  };
}
export function setReadStatus(
  id: string,
  value: string,
  library: LibraryStorage,
) {
  const meta = requireBook(id, library),
    tracker = ensureTracker(meta, library),
    read = trueFlag(value);
  library.db.updateWish(tracker.id, {
    read,
    read_status: read ? "read" : "unread",
    updated_at: nowIso(),
  });
  syncTracker(meta, library.db.getWishByLibraryBookId(id)!, library);
  return bookView(meta, library);
}
export function archiveBook(id: string, library: LibraryStorage) {
  const meta = requireBook(id, library);
  meta.archived = true;
  meta.updated_at = nowIso();
  library.saveMetadata(meta);
  library.archiveBook(id);
}
export function restoreBook(id: string, library: LibraryStorage) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(404, "书籍不存在");
  library.restoreBook(id);
}
export function deleteBook(id: string, library: LibraryStorage) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(404, "书籍不存在");
  library.deleteBook(id);
}
