import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { metadataFromDict, type Book, type Job, type Metadata, type Volume } from "../../core/models";
import { bookFromDict } from "../../core/models";
import { buildEpub, buildEpubFromSectionStream, extractCover, extractEpubMetadata, stripWebpAssetsAndRefs, updateEpubMetadata, type StreamBuildSection } from "../../core/epub";
import type { ParsedBookSection } from "../../core/parsing";
import { LibraryStorage, coverPath, epubPath, saveBook, saveCoverBytes, sourcePath, writeSourceFile } from "../storage";
import { parseBookFile, parseBookFileEvents, textFileHasContent } from "../parsing";
import { getRule } from "../templates";
import { nowIso } from "../db";
import { composeBookCss } from "../epub-css";
import { duplicateBooks, ensureTracker, resolveTxtIdentity } from "./identity";
import { queueDirectory, detectSourceType } from "./staging";

export const fieldNames = ["title", "author", "language", "description", "series", "identifier", "publisher", "tags", "published", "isbn", "rating", "rule_template", "theme_template", "custom_css"] as const;
export type UploadFields = Record<typeof fieldNames[number], string>;
export interface UploadSpec { version: 1; filename: string; content_type: string; payload_name: string; fields: UploadFields; dedupe_mode: string; cover_name: string | null }
export const emptyFields = (): UploadFields => Object.fromEntries(fieldNames.map(k => [k, k === "rule_template" ? "default" : ""])) as UploadFields;
export function updateJob(library: LibraryStorage, id: string, fields: Partial<Job>): void { library.db.updateJob(id, { ...fields, updated_at: nowIso() }); }
export function updateMetaSynced(meta: Metadata): void { meta.status = "synced"; meta.epub_updated_at = meta.updated_at = nowIso(); }
function atomicWrite(path: string, data: Uint8Array): void {
  const temporary = path + ".ingest.tmp";
  try { writeFileSync(temporary, data); renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
}
function coverAsset(library: LibraryStorage, meta: Metadata) {
  return meta.cover_file ? { name: meta.cover_file, data: readFileSync(coverPath(library.base, meta.book_id, meta.cover_file)) } : null;
}
function metadata(id: string, fields: UploadFields, extracted: Partial<Metadata>, epub: boolean): Metadata {
  const now = nowIso(), tags = fields.tags.trim() ? fields.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean) : epub ? extracted.tags || [] : [];
  const ratingText = fields.rating.trim(), rating = /^[+-]?\d+$/.test(ratingText) ? Math.max(0, Math.min(5, Number(ratingText))) : null;
  const picked: Partial<Metadata> = {};
  for (const key of ["title", "author", "language", "description", "series", "identifier", "publisher", "published", "isbn"] as const) Object.assign(picked, { [key]: fields[key].trim() || extracted[key] || null });
  return metadataFromDict({ ...picked, book_id: id, title: picked.title || "未命名", language: picked.language || "zh-CN", source_type: epub ? "epub" : "txt", tags, rating: ratingText ? rating : epub ? extracted.rating ?? null : null, rule_template: epub ? null : fields.rule_template, theme_template: fields.theme_template.trim() === "__book__" && epub ? "__book__" : fields.theme_template.trim() && fields.theme_template.trim() !== "__book__" ? fields.theme_template.trim() : "default", custom_css: fields.custom_css.trim() || null, status: epub ? "synced" : "dirty", epub_updated_at: epub ? now : null, created_at: now, updated_at: now });
}
function appendStub(book: Book, section: ParsedBookSection, current: Volume | null): Volume | null {
  if (section.kind === "volume") {
    current = { title: section.title, lines: [], chapters: [] }; book.volumes.push(current); book.spine.push(current); return current;
  }
  if (section.volume_title) {
    if (!current || current.title !== section.volume_title) { current = { title: section.volume_title, lines: [], chapters: [] }; book.volumes.push(current); book.spine.push(current); }
  } else current = null;
  const chapter = { title: section.title, lines: [], volume: current };
  if (current) current.chapters.push(chapter); else book.root_chapters.push(chapter);
  book.spine.push(chapter); return current;
}
/** Use file events and empty section stubs, never retain the full parsed TXT book. */
function buildTxt(library: LibraryStorage, job: Job, meta: Metadata, file: string, name: string, upload: boolean): void {
  const rule = getRule(meta.rule_template || "default");
  const events = parseBookFileEvents(file, name, rule?.rules), first = events.next().value;
  if (!first || !("intro" in first)) throw new Error("无法解析文本元信息");
  const stub = bookFromDict({ title: meta.title, author: meta.author, intro: first.intro }); let current: Volume | null = null;
  function* sections(): Generator<StreamBuildSection> {
    for (const section of events) if ("kind" in section) { current = appendStub(stub, section, current); yield { kind: section.kind, title: section.title, lines: section.lines }; }
  }
  updateJob(library, job.id, { stage: "生成 EPUB" });
  const data = buildEpubFromSectionStream({ stream_sections: sections(), source_author: upload ? resolveTxtIdentity(name, first.title, first.author)[1] : first.author, source_intro: first.intro, meta, cover: coverAsset(library, meta), css_text: composeBookCss(meta) });
  atomicWrite(epubPath(library.base, meta.book_id), data); saveBook(stub, library.base, meta.book_id);
}
export function runRegenerate(library: LibraryStorage, job: Job): Metadata {
  const meta = library.loadMetadata(job.book_id!);
  if (meta.archived || meta.source_type === "epub") throw new Error("EPUB import cannot regenerate");
  const path = sourcePath(library.base, meta.book_id);
  if (!existsSync(path)) throw new Error("Source missing");
  meta.rule_template = job.rule_template?.trim() || "default"; meta.status = "dirty"; meta.updated_at = nowIso(); library.saveMetadata(meta);
  buildTxt(library, job, meta, path, meta.book_id, false);
  updateMetaSynced(meta); library.saveMetadata(meta); return meta;
}
function refreshCover(library: LibraryStorage, meta: Metadata): void {
  let cover: ReturnType<typeof extractCover>;
  try { cover = extractCover(readFileSync(epubPath(library.base, meta.book_id))); } catch { return; }
  meta.cover_file = cover ? saveCoverBytes(library.base, meta.book_id, cover[0], cover[1]) : null;
}
export function runEditWriteback(library: LibraryStorage, job: Job): Metadata {
  const meta = library.loadMetadata(job.book_id!);
  if (meta.archived) throw new Error("Book archived");
  updateJob(library, job.id, { stage: "写元数据" });
  const path = epubPath(library.base, meta.book_id);
  if (meta.source_type !== "epub" && existsSync(path)) refreshCover(library, meta);
  updateJob(library, job.id, { stage: "写回 EPUB" });
  if (meta.source_type !== "epub" && existsSync(sourcePath(library.base, meta.book_id))) {
    const book = parseBookFile(sourcePath(library.base, meta.book_id), meta.book_id, getRule(meta.rule_template || "default")?.rules);
    atomicWrite(path, buildEpub(book, meta, { cover: coverAsset(library, meta), css_text: composeBookCss(meta) })); saveBook(book, library.base, meta.book_id);
  }
  else atomicWrite(path, updateEpubMetadata(readFileSync(path), meta, { cover: meta.source_type === "epub" ? null : coverAsset(library, meta), css_text: composeBookCss(meta) }));
  updateJob(library, job.id, { stage: "刷新封面" }); refreshCover(library, meta);
  updateMetaSynced(meta); library.saveMetadata(meta); return meta;
}
function loadSpec(library: LibraryStorage, job: Job): { spec: UploadSpec; path: string; directory: string } {
  const directory = queueDirectory(library, job.id), spec = JSON.parse(readFileSync(join(directory, "task.json"), "utf8")) as UploadSpec;
  if (spec.version !== 1 || typeof spec.payload_name !== "string" || spec.payload_name !== basename(spec.payload_name) || /[\\]/.test(spec.payload_name) || spec.payload_name === ".." || !spec.fields || fieldNames.some(k => typeof spec.fields[k] !== "string") || typeof spec.filename !== "string" || typeof spec.content_type !== "string") throw new Error("Invalid upload descriptor");
  return { spec, path: join(directory, spec.payload_name), directory };
}
function runUpload(library: LibraryStorage, job: Job): Metadata | null {
  let payload: ReturnType<typeof loadSpec>;
  try { payload = loadSpec(library, job); } catch { updateJob(library, job.id, { status: "failed", stage: "失败", message: "读取队列文件失败" }); return null; }
  const { spec, path, directory } = payload, fields = spec.fields;
  let size: number;
  try { const stat = statSync(path); if (!stat.isFile()) throw new Error("Not a file"); size = stat.size; }
  catch { updateJob(library, job.id, { status: "failed", stage: "失败", message: "读取队列文件失败" }); return null; }
  if (!size) { updateJob(library, job.id, { status: "failed", stage: "失败", message: "上传文件为空" }); return null; }
  const dataProbe = Buffer.alloc(4096);
  // Detection uses only the prefix; TXT parsing stays on the file event path.
  const sourceName = basename(spec.filename, extname(spec.filename));
  const kind = detectSourceType(spec.filename, spec.content_type, readProbe(path, dataProbe));
  let extracted: Partial<Metadata>;
  if (kind === "txt") {
    if (!textFileHasContent(path)) { updateJob(library, job.id, { status: "failed", stage: "失败", message: `${spec.filename}: 文本为空或无法解码`, log: null }); return null; }
    const first = parseBookFileEvents(path, sourceName, getRule(fields.rule_template)?.rules).next().value;
    if (!first || !("intro" in first)) throw new Error("无法解析文本元信息");
    const [title, author] = resolveTxtIdentity(sourceName, first.title, first.author);
    extracted = { title, author, description: first.intro };
  } else if (kind === "epub") extracted = extractEpubMetadata(readFileSync(path), sourceName);
  else { updateJob(library, job.id, { status: "failed", stage: "失败", message: `${spec.filename}: 不支持的文件类型`, log: null }); return null; }
  if (spec.dedupe_mode === "normalize") {
    const duplicates = duplicateBooks(library, fields.title.trim() || extracted.title || null, fields.author.trim() || extracted.author || null, fields.isbn.trim() || extracted.isbn || null);
    if (duplicates.length) {
      const meta = library.loadMetadata(duplicates[0]!.book_id); ensureTracker(library, meta);
      updateJob(library, job.id, { book_id: meta.book_id, status: "success", stage: "完成", message: "归一到已入库书籍" }); return null;
    }
  }
  const meta = metadata(job.book_id!, fields, extracted, kind === "epub");
  mkdirSync(join(library.base, meta.book_id), { recursive: true });
  updateJob(library, job.id, { stage: kind === "epub" ? "导入 EPUB" : "写元数据" });
  const cover = existsSync(join(directory, "cover")) ? readFileSync(join(directory, "cover")) : null;
  if (cover?.length) meta.cover_file = saveCoverBytes(library.base, meta.book_id, cover, spec.cover_name);
  if (kind === "txt") {
    buildTxt(library, job, meta, path, sourceName, true);
    library.saveMetadata(meta); writeSourceFile(library.base, meta.book_id, path);
  } else {
    const epub = epubPath(library.base, meta.book_id), data = stripWebpAssetsAndRefs(readFileSync(path)).data;
    atomicWrite(epub, data); saveBook(bookFromDict({ title: meta.title, author: meta.author }), library.base, meta.book_id); library.saveMetadata(meta);
    if (!cover?.length) refreshCover(library, meta);
    const css = composeBookCss(meta);
    if (fieldNames.some(key => !["rule_template", "theme_template", "custom_css"].includes(key) && fields[key].trim()) || cover?.length || css) {
      updateJob(library, job.id, { stage: "写回 EPUB" });
      atomicWrite(epub, updateEpubMetadata(data, meta, { cover: coverAsset(library, meta), css_text: css }));
    }
  }
  updateMetaSynced(meta); library.saveMetadata(meta); ensureTracker(library, meta); return meta;
}
import { openSync, readSync, closeSync } from "node:fs";
function readProbe(path: string, buffer: Buffer): Uint8Array { const fd = openSync(path, "r"); try { return buffer.subarray(0, readSync(fd, buffer)); } finally { closeSync(fd); } }
export function processJob(library: LibraryStorage, job: Job): void {
  const upload = ["upload", "upload-epub", "ingest"].includes(job.action);
  try {
    const meta = upload ? runUpload(library, job) : job.action === "edit-writeback" ? runEditWriteback(library, job) : runRegenerate(library, job);
    if (meta) updateJob(library, job.id, { book_id: meta.book_id, status: "success", stage: "完成", message: "完成" });
  } catch (error) {
    if (!upload && job.book_id) {
      try { const meta = library.loadMetadata(job.book_id); meta.status = "failed"; meta.updated_at = nowIso(); library.saveMetadata(meta); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") console.error(missing); }
    }
    updateJob(library, job.id, { status: "failed", stage: "失败", message: job.action === "edit-writeback" ? "写回失败" : job.action === "upload-epub" ? "导入失败" : "转换失败", log: error instanceof Error ? error.stack || error.message : String(error) });
  } finally { if (upload) rmSync(queueDirectory(library, job.id), { recursive: true, force: true }); }
}
