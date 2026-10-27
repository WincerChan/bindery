import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document, Element, Node } from "@xmldom/xmldom";
import { isDocumentMediaType, manifestFromOpf, renderSection } from "../../core/epub";
import { inlineCssImports } from "../../core/css-strip";
import { patchDocHtmlBinderyCss } from "../../core/epub-html";
import { metadataFromDict } from "../../core/models";
import { attr, child, children, descendants } from "../../core/xml";
import { composeBookCss } from "../epub-css";
import { parseBookFileEvents } from "../parsing";
import { ReadLimitError } from "../read-limits";
import { ReaderArchive } from "../reader/archive";
import { isolatedBookHtml } from "../reader/resources";
import type { LibraryStorage } from "../storage";
import { getRule } from "../templates";
import { loadStaged, type StagedUpload } from "./staging";

export interface FirstPageInput { upload_token: string; rule_id: string; theme_id: string }
export type FirstPageResult = { section_title: string; volume_title: string | null; html: string } | { error: string };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const parse = (html: string) => new DOMParser({ onError: () => {} }).parseFromString(html, "text/html");
const serialize = (node: Node) => new XMLSerializer().serializeToString(node);
const standalone = (html: string) => isolatedBookHtml(encoder.encode(html), "/", "https://preview.invalid/", undefined, true);
const invalidToken = { error: "上传暂存已失效，请重新选择文件后再预览。" };
const MAX_TXT_BYTES = 256 * 1024, MAX_MEMBER_BYTES = 2 * 1024 * 1024, MAX_EPUB_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENTS = 64, MAX_CSS_DEPTH = 8;
// Enough prose to distinguish an unmarked title/TOC from body text, without requiring
// paragraphs or a particular language. Semantics and the short-text fallback override this.
const MIN_PROSE_CHARACTERS = 24;
const starts = new Set(["bodymatter", "text", "chapter"]);
const navigation = new Set(["toc", "nav", "landmarks", "page-list"]);
const frontMatter = new Set(["cover", "titlepage", "title-page", ...navigation]);
const nonContent = new Set("head script style svg img image iframe frame frameset object embed applet portal form input button textarea select option audio video source track template noscript".split(" "));

function appendTheme(doc: Document, css: string): void {
  if (!css) return;
  const head = doc.getElementsByTagName("head")[0] || doc.documentElement!.insertBefore(doc.createElement("head"), doc.documentElement!.firstChild);
  const style = doc.createElement("style"); style.textContent = css; head.appendChild(style);
}
function txtPage(entry: StagedUpload, input: FirstPageInput, css: string): FirstPageResult {
  const name = basename(entry.filename, extname(entry.filename));
  // No synthetic volume markup and no partial chapter: hitting the input ceiling
  // before a complete chapter has been emitted raises ReadLimitError.
  for (const event of parseBookFileEvents(entry.payload_path, name, getRule(input.rule_id)?.rules, { maxBytes: MAX_TXT_BYTES })) {
    if (!("kind" in event) || event.kind !== "chapter" || !event.lines.some(line => line.trim())) continue;
    const doc = parse(renderSection(event.title, event.lines, "zh-CN", "chapter"));
    appendTheme(doc, css);
    return { section_title: event.title, volume_title: event.volume_title, html: standalone(serialize(doc)) };
  }
  return { error: "未找到可预览的正文章节" };
}

/** Indexed reads only: never inflate images/fonts or scan later chapter titles. */
class PreviewArchive extends ReaderArchive {
  private remaining = MAX_EPUB_BYTES;
  override read(path: string): Uint8Array | undefined {
    const size = this.members.get(path)?.size ?? 0;
    if (size > MAX_MEMBER_BYTES || size > this.remaining) throw new ReadLimitError();
    const limit = Math.min(MAX_MEMBER_BYTES, this.remaining);
    this.remaining -= size;
    return super.read(path, limit);
  }
}
function semanticTypes(el: Element): string[] {
  return [...attr(el, "epub:type").toLowerCase().split(/\s+/), ...attr(el, "role").toLowerCase().split(/\s+/).map(role => role.replace(/^doc-/, ""))];
}
function hasType(el: Element, types: Set<string>): boolean { return semanticTypes(el).some(type => types.has(type)); }
function contentText(node: Node, prose = false, excluded?: Set<string>): string {
  if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue || "";
  if (node.nodeType !== 1) return "";
  const el = node as Element, tag = (el.localName || el.tagName).toLowerCase();
  if (nonContent.has(tag) || excluded && hasType(el, excluded)) return "";
  if (prose && (tag === "nav" || tag === "a" || /^h[1-6]$/.test(tag) || hasType(el, frontMatter))) return "";
  let text = "";
  for (let node = el.firstChild; node; node = node.nextSibling) text += contentText(node, prose, excluded);
  return text;
}
function semanticDocument(doc: Document, body: Element, types: Set<string>): boolean {
  if (hasType(doc.documentElement!, types) || hasType(body, types)) return true;
  // A heading outside a marked TOC/title wrapper does not turn it into a chapter.
  return descendants(body).some(node => hasType(node, types)) && !contentText(body, true, types).trim();
}
function navigationDocument(doc: Document, body: Element): boolean {
  return semanticDocument(doc, body, navigation) || Boolean(body.getElementsByTagName("nav").length && !contentText(body, true).trim());
}
interface SpinePlan { paths: string[]; preferred: Set<string>; excluded: Set<string>; nav: Set<string> }
function addHint(plan: SpinePlan, path: string, types: string[]): void {
  if (types.some(type => starts.has(type))) plan.preferred.add(path);
  if (types.some(type => frontMatter.has(type))) plan.excluded.add(path);
  if (types.some(type => navigation.has(type))) plan.nav.add(path);
}
function spinePlan(archive: PreviewArchive): SpinePlan {
  const [opf, root] = archive.opf(), items = manifestFromOpf(opf, root, archive.resolve.bind(archive));
  const byId = new Map(items.map(item => [item.item_id, item])), spine = child(root, "spine");
  // Unlike the general reader helper, filenames never classify navigation here.
  const paths = spine ? children(spine, "itemref").flatMap(node => {
    const item = byId.get(attr(node, "idref").trim());
    return item && isDocumentMediaType(item.media_type) && !item.properties.has("nav") && attr(node, "linear").trim().toLowerCase() !== "no" ? [item.member_path] : [];
  }) : [];
  const plan: SpinePlan = { paths: [...new Set(paths)], preferred: new Set(), excluded: new Set(), nav: new Set() };
  for (const reference of descendants(root, "reference")) addHint(plan, archive.resolve(opf, attr(reference, "href")), attr(reference, "type").toLowerCase().split(/\s+/));
  // Landmarks are explicit start hints; reading the nav is not a scan of all chapters.
  for (const item of items) if (item.properties.has("nav")) {
    const bytes = archive.read(item.member_path); if (!bytes) continue;
    const doc = parse(decoder.decode(bytes));
    for (const nav of Array.from(doc.getElementsByTagName("nav"))) if (semanticTypes(nav).includes("landmarks")) {
      for (const link of Array.from(nav.getElementsByTagName("a"))) addHint(plan, archive.resolve(item.member_path, attr(link, "href")), semanticTypes(link));
    }
  }
  return plan;
}
interface PickedDocument { path: string; doc: Document }
function pickDocument(archive: PreviewArchive): PickedDocument | null {
  const plan = spinePlan(archive), order = new Map(plan.paths.map((path, i) => [path, i]));
  const paths = [...plan.paths.filter(path => plan.preferred.has(path)), ...plan.paths.filter(path => !plan.preferred.has(path))];
  let fallback: PickedDocument | null = null;
  for (const path of paths.slice(0, MAX_DOCUMENTS)) {
    if (plan.nav.has(path)) continue;
    const bytes = archive.read(path); if (!bytes) continue;
    const doc = parse(decoder.decode(bytes)), body = doc.getElementsByTagName("body")[0];
    if (!body || !contentText(body).trim() || navigationDocument(doc, body) || plan.excluded.has(path) || semanticDocument(doc, body, frontMatter)) continue;
    const candidate = { path, doc };
    if (!fallback || order.get(path)! < order.get(fallback.path)!) fallback = candidate;
    const semanticStart = plan.preferred.has(path) || [doc.documentElement!, body, ...descendants(body)].some(node => hasType(node, starts) && contentText(node).trim());
    if (semanticStart) return candidate;
    if (contentText(body, true).replace(/[^\p{L}\p{N}]/gu, "").length >= MIN_PROSE_CHARACTERS) return candidate;
  }
  // Do not claim there is no better candidate after an incomplete scan.
  if (paths.length > MAX_DOCUMENTS) throw new ReadLimitError();
  return fallback;
}

function resolveImports(archive: PreviewArchive, css: string, from: string, seen: Set<string>): string {
  return inlineCssImports(css, href => {
    const target = archive.resolve(from, href);
    if (!target || seen.has(target) || seen.size >= MAX_CSS_DEPTH) return undefined;
    const bytes = archive.read(target);
    return bytes ? resolveImports(archive, decoder.decode(bytes), target, new Set([...seen, target])) : undefined;
  });
}
function inlineStylesheets(archive: PreviewArchive, doc: Document, path: string): void {
  // Snapshot inline styles first, so linked imports are never re-resolved relative to the document.
  for (const style of Array.from(doc.getElementsByTagName("style"))) style.textContent = resolveImports(archive, style.textContent || "", path, new Set());
  for (const link of Array.from(doc.getElementsByTagName("link"))) {
    const target = archive.resolve(path, attr(link, "href"));
    if (!attr(link, "rel").toLowerCase().split(/\s+/).includes("stylesheet") || !target) { link.parentNode?.removeChild(link); continue; }
    const bytes = archive.read(target), style = doc.createElement("style"), media = attr(link, "media");
    const css = bytes ? resolveImports(archive, decoder.decode(bytes), target, new Set([target])) : "";
    style.textContent = media ? `@media ${media} {\n${css}\n}` : css;
    link.parentNode?.replaceChild(style, link);
  }
}
function applyEpubTheme(doc: Document, css: string): Document {
  // Ingest retains book CSS and appends an overlay, replacing old Bindery links.
  if (!css) return doc;
  const themed = parse(patchDocHtmlBinderyCss(serialize(doc), null));
  appendTheme(themed, css);
  return themed;
}
function documentTitle(doc: Document, path: string): string {
  return ["h1", "h2", "title"].map(tag => doc.getElementsByTagName(tag)[0]?.textContent?.trim()).find(Boolean) || basename(path);
}
function epubPage(entry: StagedUpload, css: string): FirstPageResult {
  const archive = new PreviewArchive(entry.payload_path, statSync(entry.payload_path, { bigint: true }), () => {});
  const picked = pickDocument(archive);
  if (!picked) return { error: "未找到可预览的正文章节" };
  const doc = applyEpubTheme(picked.doc, css);
  inlineStylesheets(archive, doc, picked.path);
  return { section_title: documentTitle(doc, picked.path), volume_title: null, html: standalone(serialize(doc)) };
}

/** Read-only: the staging lookup is the sole authority for token -> filesystem path. */
export function firstPagePreview(library: LibraryStorage, input: unknown): FirstPageResult {
  if (!input || typeof input !== "object" || !["upload_token", "rule_id", "theme_id"].every(key => typeof (input as Record<string, unknown>)[key] === "string")) return { error: "预览参数无效" };
  const data = input as FirstPageInput;
  let entry: StagedUpload | null;
  try { entry = loadStaged(library, data.upload_token); } catch { return invalidToken; }
  if (!entry) return invalidToken;
  if (!entry.size) return { error: "空文件" };
  if (!["txt", "epub"].includes(entry.kind)) return { error: "不支持的文件类型（仅支持 .txt / .epub）" };
  try {
    const theme = data.theme_id.trim();
    const css = composeBookCss(metadataFromDict({ source_type: entry.kind, theme_template: theme === "__book__" && entry.kind !== "epub" ? "default" : theme || "default" }));
    return entry.kind === "txt" ? txtPage(entry, data, css) : epubPage(entry, css);
  } catch (error) {
    return { error: error instanceof ReadLimitError ? error.message : entry.kind === "epub" ? "解析 EPUB 失败" : "解析文本失败" };
  }
}

export async function firstPageResponse(request: Request, library: LibraryStorage): Promise<Response> {
  let input: unknown;
  try { input = await request.json(); } catch { return Response.json({ error: "预览参数无效" }, { status: 400 }); }
  return Response.json(firstPagePreview(library, input), { headers: { "Cache-Control": "no-store" } });
}
