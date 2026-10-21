import type { Book, Metadata } from "./models";
import * as templates from "./epub-templates";
import { splitlines, strip } from "./text";
import { splitChapterTitle, injectBase, stripScripts } from "./epub-html";
import {
  basename,
  canonicalZipMember,
  dirname,
  extension,
  joinpath,
  normalizeEpubArchivePaths,
  readArchive,
  writeArchive,
  writeArchiveToSink,
} from "./archive";
import type { ArchiveMember } from "./archive";
import { attr, child, children, descendants, parseXml } from "./xml";
import type { Element } from "./xml";
import { DOMParser } from "@xmldom/xmldom";
export { canonicalZipMember, normalizeEpubArchivePaths } from "./archive";
export { updateEpubMetadata, stripWebpAssetsAndRefs } from "./epub-patch";
export interface EpubSection {
  title: string;
  item_path: string;
}
export interface EpubSectionDocument extends EpubSection {
  index: number;
  content: Uint8Array;
  media_type: string;
}
export interface StreamBuildSection {
  kind: string;
  title: string;
  lines: Iterable<string>;
}
export interface CoverAsset {
  name: string;
  data: Uint8Array;
}
export interface BuildOptions {
  cover?: CoverAsset | null;
  css_text?: string | null;
}
interface BuildSection extends templates.TemplateSection {
  kind: string;
  content: string;
}
const encode = (text: string) => new TextEncoder().encode(text);
export function safeEpubMemberName(filename: string, fallback: string): string {
  let name = basename(filename)
    .replace(/[^0-9A-Za-z._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  if (!name) return fallback;
  if (!name.includes(".") && fallback.includes("."))
    name += extension(fallback);
  return name;
}
export function guessMediaType(path: string): string {
  return (
    (
      {
        ".xhtml": "application/xhtml+xml",
        ".html": "application/xhtml+xml",
        ".htm": "application/xhtml+xml",
        ".css": "text/css",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".ncx": "application/x-dtbncx+xml",
      } as Record<string, string>
    )[extension(path).toLowerCase()] ?? "application/octet-stream"
  );
}
export function guessImageMediaType(path: string): string {
  const media = guessMediaType(path);
  return media.startsWith("image/") ? media : "image/jpeg";
}
function renderSection(
  title: string,
  lines: Iterable<string>,
  lang: string,
  kind: string,
): string {
  const [stamp, main_title] = splitChapterTitle(title, kind);
  return templates.section({
    title,
    lang,
    kind,
    stamp,
    main_title,
    paragraphs: [...lines].filter(Boolean),
  });
}
function renderIntro(
  title: string,
  author: string | null,
  intro: string,
  lang: string,
): string {
  return templates.intro({
    title,
    author,
    lang,
    paragraphs: splitlines(intro).map(strip).filter(Boolean),
  });
}
function makeSection(
  index: number,
  kind: string,
  title: string,
  lines: Iterable<string>,
  meta: Metadata,
  sourceAuthor: string | null,
): BuildSection {
  const number = String(index).padStart(4, "0"),
    lang = meta.language || "zh-CN",
    normalized = [...lines].filter(Boolean);
  return {
    item_id: `sec${number}`,
    href: `Text/section_${number}.xhtml`,
    title,
    kind,
    content:
      kind === "intro"
        ? renderIntro(
            meta.title,
            meta.author || sourceAuthor,
            normalized.join("\n"),
            lang,
          )
        : renderSection(title, normalized, lang, kind),
  };
}
function archiveHeaders(
  sections: templates.TemplateSection[],
  meta: Metadata,
  options: BuildOptions,
): ArchiveMember[] {
  const lang = meta.language || "zh-CN",
    identifier = meta.identifier || meta.book_id;
  const cover_href = options.cover
    ? `Images/${safeEpubMemberName(options.cover.name, "cover.jpg")}`
    : null;
  const opf = templates.content({
    ...meta,
    language: lang,
    tags: meta.tags.filter(Boolean),
    identifier_urn: identifier.startsWith("urn:")
      ? identifier
      : `urn:uuid:${identifier}`,
    modified: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    sections,
    cover_href,
    cover_media_type: cover_href ? guessImageMediaType(cover_href) : null,
    cover_item_id: cover_href ? "cover-image" : null,
  });
  const entries: ArchiveMember[] = [
    { name: "mimetype", data: encode("application/epub+zip") },
    { name: "META-INF/container.xml", data: encode(templates.container()) },
    { name: "EPUB/content.opf", data: encode(opf) },
    {
      name: "EPUB/nav.xhtml",
      data: encode(templates.nav({ title: meta.title, lang, sections })),
    },
    {
      name: "EPUB/toc.ncx",
      data: encode(templates.toc({ title: meta.title, sections })),
    },
    {
      name: "EPUB/Styles/style.css",
      data: encode(strip(options.css_text || "")),
    },
  ];
  return entries;
}
function buildArchive(sections: BuildSection[], meta: Metadata, options: BuildOptions): Uint8Array {
  if (!sections.length) sections.push(makeSection(1, "chapter", "正文", ["（无内容）"], meta, null));
  const entries = archiveHeaders(sections, meta, options);
  for (const section of sections) entries.push({ name: `EPUB/${section.href}`, data: encode(section.content) });
  if (options.cover) entries.push({ name: `EPUB/Images/${safeEpubMemberName(options.cover.name, "cover.jpg")}`, data: options.cover.data });
  return writeArchive(entries);
}
/**
 * Two passes keep the original ZIP member order without retaining chapter bodies.
 * The factory must reopen the same source on each pass. Only the section index,
 * one rendered section and the ZIP central directory remain in memory.
 */
export function writeEpubFromSectionStream(args: {
  stream_sections: () => Iterable<StreamBuildSection>;
  source_author: string | null;
  source_intro: string | null;
  meta: Metadata;
} & BuildOptions, write: (chunk: Uint8Array) => void): void {
  const sections: templates.TemplateSection[] = [];
  let index = 1;
  const descriptor = (title: string) => {
    const number = String(index++).padStart(4, "0");
    return { item_id: `sec${number}`, href: `Text/section_${number}.xhtml`, title };
  };
  if (args.source_intro) sections.push(descriptor("简介"));
  for (const entry of args.stream_sections()) sections.push(descriptor(entry.title));
  const empty = !sections.length;
  if (empty) sections.push(descriptor("正文"));
  function* entries(): Generator<ArchiveMember> {
    yield* archiveHeaders(sections, args.meta, args);
    let i = 0;
    const member = (section: BuildSection): ArchiveMember => {
      const expected = sections[i++];
      if (!expected || expected.title !== section.title || expected.href !== section.href) throw new Error("EPUB section stream changed between passes");
      return { name: `EPUB/${section.href}`, data: encode(section.content) };
    };
    let n = 1;
    if (args.source_intro) yield member(makeSection(n++, "intro", "简介", splitlines(args.source_intro).map(strip).filter(Boolean), args.meta, args.source_author));
    for (const section of args.stream_sections()) yield member(makeSection(n++, section.kind, section.title, section.lines, args.meta, args.source_author));
    if (empty) yield member(makeSection(1, "chapter", "正文", ["（无内容）"], args.meta, null));
    if (i !== sections.length) throw new Error("EPUB section stream changed between passes");
    if (args.cover) yield { name: `EPUB/Images/${safeEpubMemberName(args.cover.name, "cover.jpg")}`, data: args.cover.data };
  }
  writeArchiveToSink(entries(), write);
}
export function buildEpub(
  book: Book,
  meta: Metadata,
  options: BuildOptions = {},
): Uint8Array {
  const sections: BuildSection[] = [];
  let index = 1;
  if (book.intro)
    sections.push(
      makeSection(
        0,
        "intro",
        "简介",
        splitlines(book.intro).map(strip).filter(Boolean),
        meta,
        book.author,
      ),
    );
  for (const item of book.spine) {
    if ("chapters" in item) {
      if (item.lines.length)
        sections.push(
          makeSection(
            index++,
            "volume",
            item.title,
            item.lines,
            meta,
            book.author,
          ),
        );
    } else
      sections.push(
        makeSection(
          index++,
          "chapter",
          item.title,
          item.lines,
          meta,
          book.author,
        ),
      );
  }
  return buildArchive(sections, meta, options);
}
export function buildEpubFromSectionStream(
  args: {
    stream_sections: Iterable<StreamBuildSection>;
    source_author: string | null;
    source_intro: string | null;
    meta: Metadata;
  } & BuildOptions,
): Uint8Array {
  const sections: BuildSection[] = [];
  let index = 1;
  if (args.source_intro)
    sections.push(
      makeSection(
        index++,
        "intro",
        "简介",
        splitlines(args.source_intro).map(strip).filter(Boolean),
        args.meta,
        args.source_author,
      ),
    );
  for (const entry of args.stream_sections)
    sections.push(
      makeSection(
        index++,
        entry.kind,
        entry.title,
        entry.lines,
        args.meta,
        args.source_author,
      ),
    );
  return buildArchive(sections, args.meta, args);
}
export interface ManifestItem {
  item_id: string;
  href: string;
  media_type: string;
  properties: Set<string>;
  member_path: string;
}
export const isDocumentMediaType = (media: string) =>
  ["application/xhtml+xml", "text/html"].includes(strip(media).toLowerCase());
const isNavItem = (item: ManifestItem) =>
  item.properties.has("nav") ||
  ["nav.xhtml", "nav.html"].includes(basename(item.member_path).toLowerCase());
export const resolveOpfHref = (opfPath: string, href: string) =>
  canonicalZipMember(joinpath(dirname(opfPath), href));
const resolveRelative = (path: string, href: string) =>
  strip(href.split("#")[0])
    ? resolveOpfHref(path, strip(href.split("#")[0]))
    : "";
export function pathLookupKeys(path: string): string[] {
  const name = canonicalZipMember(path);
  return name
    ? [
        ...new Set([
          name,
          ...(name.startsWith("EPUB/") ? [name.slice(5)] : []),
          basename(name),
        ]),
      ]
    : [];
}
/** Reader archives can provide indexed, on-demand reads without unpacking the ZIP. */
export interface EpubSource {
  read(path: string): Uint8Array | undefined;
  opf(): [string, Element];
  resolve?(from: string, href: string): string;
}
export class EpubArchive implements EpubSource {
  entries: ArchiveMember[];
  index = new Map<string, ArchiveMember>();
  constructor(data: Uint8Array) {
    this.entries = readArchive(data);
    for (const e of this.entries) {
      const name = canonicalZipMember(e.name);
      if (name && !this.index.has(name)) this.index.set(name, e);
    }
  }
  locate(path: string): [string, ArchiveMember] | undefined {
    const name = canonicalZipMember(path);
    if (!name) return undefined;
    for (const candidate of [
      ...pathLookupKeys(name),
      ...pathLookupKeys(
        name.startsWith("EPUB/") ? name.slice(5) : `EPUB/${name}`,
      ),
    ]) {
      const entry = this.index.get(candidate);
      if (entry) return [candidate, entry];
    }
    const matches = [...this.index].filter(
      ([key]) => basename(key) === basename(name),
    );
    if (matches.length > 1)
      for (const suffix of [
        `/Text/${basename(name)}`,
        `/text/${basename(name)}`,
        `/${basename(name)}`,
      ]) {
        const found = matches.find(([key]) => key.endsWith(suffix));
        if (found) return found;
      }
    return matches[0];
  }
  read(path: string): Uint8Array | undefined {
    return this.locate(path)?.[1].data;
  }
  opfPath(): string {
    const container = this.entries.find(
      (e) => e.name === "META-INF/container.xml",
    );
    if (!container) throw new Error("Missing META-INF/container.xml");
    const root = parseXml(container.data),
      roots = [root, ...descendants(root)].filter(
        (n) => n.localName === "rootfile",
      );
    const ns = roots.find(
      (n) =>
        n.namespaceURI === "urn:oasis:names:tc:opendocument:xmlns:container",
    );
    const path = canonicalZipMember(
      strip(ns ? attr(ns, "full-path") : "") ||
        strip(
          attr(
            roots.find((n) => strip(attr(n, "full-path"))) ?? root,
            "full-path",
          ),
        ),
    );
    if (!path) throw new Error("Missing OPF path in container.xml");
    return path;
  }
  opf(): [string, Element] {
    const path = this.opfPath(),
      data = this.read(path);
    if (!data) throw new Error(`Missing ${path}`);
    return [path, parseXml(data)];
  }
}
export function manifestFromOpf(path: string, root: Element, resolve = resolveOpfHref): ManifestItem[] {
  const manifest = child(root, "manifest");
  if (!manifest) return [];
  return children(manifest, "item").map((node) => {
    const href = strip(attr(node, "href"));
    return {
      item_id: strip(attr(node, "id")),
      href,
      media_type: strip(attr(node, "media-type")).toLowerCase(),
      properties: new Set(
        strip(attr(node, "properties")).split(/\s+/).filter(Boolean),
      ),
      member_path: href ? resolve(path, href) : "",
    };
  });
}
export function spineDocumentItems(
  root: Element,
  items: ManifestItem[],
): ManifestItem[] {
  const byId = new Map(
      items.filter((i) => i.item_id).map((i) => [i.item_id, i]),
    ),
    spine = child(root, "spine");
  const docs = spine
    ? children(spine, "itemref").flatMap((n) => {
        const item = byId.get(strip(attr(n, "idref")));
        return item && isDocumentMediaType(item.media_type) && !isNavItem(item)
          ? [item]
          : [];
      })
    : [];
  return docs.length
    ? docs
    : items.filter((i) => isDocumentMediaType(i.media_type) && !isNavItem(i));
}
const nodeText = (node?: Element): string | null =>
  node ? strip(node.textContent || "") || null : null;
function tocTitleIndex(
  archive: EpubSource,
  items: ManifestItem[],
): Map<string, string> {
  const titles = new Map<string, string>();
  const add = (path: string, title: string | null) => {
    if (path && title)
      for (const key of pathLookupKeys(path))
        if (!titles.has(key)) titles.set(key, title);
  };
  for (const item of items.filter(
    (i) => isDocumentMediaType(i.media_type) && isNavItem(i),
  )) {
    const data = archive.read(item.member_path);
    if (!data) continue;
    let root: Element;
    try {
      root = parseXml(data);
    } catch {
      continue;
    }
    let links: Element[] = [];
    for (const nav of descendants(root, "nav")) {
      let type = "";
      for (let i = 0; i < nav.attributes.length; i++) {
        const a = nav.attributes.item(i)!;
        if (a.localName === "type") {
          type = strip(a.value).toLowerCase();
          break;
        }
      }
      if (!type || type === "toc")
        links.push(
          ...descendants(nav, "a").filter((n) => n.hasAttribute("href")),
        );
    }
    if (!links.length)
      links = descendants(root, "a").filter((n) => n.hasAttribute("href"));
    for (const link of links)
      add(
        archive.resolve?.(item.member_path, attr(link, "href")) ?? resolveRelative(item.member_path, attr(link, "href")),
        nodeText(link),
      );
  }
  for (const item of items.filter(
    (i) =>
      i.media_type === "application/x-dtbncx+xml" ||
      i.href.toLowerCase().endsWith(".ncx"),
  )) {
    const data = archive.read(item.member_path);
    if (!data) continue;
    let root: Element;
    try {
      root = parseXml(data);
    } catch {
      continue;
    }
    for (const point of descendants(root, "navPoint")) {
      const text = descendants(point, "navLabel").flatMap((n) =>
          children(n, "text"),
        )[0],
        content = descendants(point, "content").find((n) =>
          n.hasAttribute("src"),
        );
      if (content)
        add(
          archive.resolve?.(item.member_path, attr(content, "src")) ?? resolveRelative(item.member_path, attr(content, "src")),
          nodeText(text),
        );
    }
  }
  return titles;
}
function extractTitleFromHtml(text: string): string | null {
  for (const tag of ["title", "h1", "h2"]) {
    const match = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "is").exec(text);
    if (match) {
      const raw = match[1].replace(/<[^>]+>/g, "");
      const decoded =
        new DOMParser({ onError: () => {} }).parseFromString(
          `<html><body>${raw}</body></html>`,
          "text/html",
        ).documentElement?.textContent ?? "";
      const title = strip(decoded);
      if (title) return title;
    }
  }
  return null;
}
function documentTitle(
  archive: EpubSource,
  item: ManifestItem,
  titles: Map<string, string>,
  index: number,
  content?: Uint8Array,
): string {
  for (const key of pathLookupKeys(item.member_path))
    if (titles.get(key)) return titles.get(key)!;
  const bytes = content ?? archive.read(item.member_path);
  const title = bytes?.length
    ? extractTitleFromHtml(
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
      )
    : null;
  const path = item.href || item.member_path || "section",
    ext = extension(path);
  return (
    title ||
    basename(path).slice(0, ext ? -ext.length : undefined) ||
    `章节 ${index + 1}`
  );
}
export function parseEpubPackage(archive: EpubSource) {
  const [path, root] = archive.opf(),
    items = manifestFromOpf(path, root, archive.resolve?.bind(archive)),
    titles = tocTitleIndex(archive, items),
    documents = spineDocumentItems(root, items);
  const sections = documents.map((item, i) => ({
    title: documentTitle(archive, item, titles, i),
    item_path: item.member_path,
  }));
  return { items, documents, sections };
}
export function listEpubSections(data: Uint8Array): EpubSection[] {
  return parseEpubPackage(new EpubArchive(data)).sections;
}
export function* iterEpubSectionDocuments(
  data: Uint8Array,
): Generator<EpubSectionDocument> {
  const archive = new EpubArchive(data),
    [path, root] = archive.opf(),
    items = manifestFromOpf(path, root),
    titles = tocTitleIndex(archive, items);
  const docs = spineDocumentItems(root, items);
  for (let i = 0; i < docs.length; i++) {
    const item = docs[i],
      content = archive.read(item.member_path);
    if (content)
      yield {
        index: i,
        title: documentTitle(archive, item, titles, i, content),
        item_path: item.member_path,
        content,
        media_type: item.media_type || "application/octet-stream",
      };
  }
}
export const listEpubSectionDocuments = (data: Uint8Array) => [
  ...iterEpubSectionDocuments(data),
];
export function extractCover(data: Uint8Array): [Uint8Array, string] | null {
  const archive = new EpubArchive(data);
  let path: string, root: Element;
  try {
    [path, root] = archive.opf();
  } catch {
    return null;
  }
  const cover = epubCoverItem(manifestFromOpf(path, root), root);
  const payload = cover ? archive.read(cover.member_path) : undefined;
  return cover && payload ? [payload, cover.member_path] : null;
}
export function epubCoverItem(items: ManifestItem[], root: Element): ManifestItem | undefined {
  const metadata = child(root, "metadata");
  let cover: ManifestItem | undefined;
  for (const node of metadata ? children(metadata, "meta") : []) {
    if (strip(attr(node, "name")) !== "cover") continue;
    const candidate = items.find(
      (i) => i.item_id === strip(attr(node, "content")),
    );
    if (candidate?.media_type.startsWith("image/")) {
      cover = candidate;
      break;
    }
  }
  cover ??= items.find(
    (i) => i.media_type.startsWith("image/") && i.properties.has("cover-image"),
  );
  cover ??= items.find(
    (i) =>
      i.media_type.startsWith("image/") &&
      (i.item_id.toLowerCase().includes("cover") ||
        i.member_path.toLowerCase().includes("cover")),
  );
  return cover;
}
export function extractEpubMetadata(data: Uint8Array, fallbackTitle: string) {
  const archive = new EpubArchive(data),
    [, root] = archive.opf(),
    metadata = child(root, "metadata");
  const nodes = metadata ? children(metadata) : [];
  const values = (name: string) => nodes.filter((n) => n.localName === name);
  const first = (name: string) =>
    values(name).map(nodeText).find(Boolean) ?? null;
  let identifier: string | null = null,
    isbn: string | null = null,
    series: string | null = null,
    rating: number | null = null;
  for (const node of values("identifier")) {
    const value = nodeText(node);
    if (!value) continue;
    const id = strip(attr(node, "id")),
      cleaned = value.replace(/[^0-9Xx]/g, "");
    if (id === "isbn" || [10, 13].includes(cleaned.length)) {
      isbn ||= value;
      continue;
    }
    if (id === "identifier" || identifier === null) identifier = value;
  }
  for (const node of values("meta")) {
    const text = nodeText(node);
    if (strip(attr(node, "property")) === "belongs-to-collection" && text)
      series = text;
    if (
      strip(attr(node, "name")) === "rating" &&
      text &&
      Number.isFinite(Number(text))
    )
      rating = Math.max(0, Math.min(5, Math.trunc(Number(text))));
  }
  return {
    title: first("title") || fallbackTitle,
    author: first("creator"),
    language: first("language") || "zh-CN",
    description: first("description"),
    series,
    identifier,
    publisher: first("publisher"),
    tags: values("subject")
      .map(nodeText)
      .filter((s): s is string => Boolean(s)),
    published: first("date"),
    isbn,
    rating,
  };
}
export function loadEpubItem(
  data: Uint8Array,
  itemPath: string,
  baseHref: string,
): [Uint8Array, string] {
  const archive = new EpubArchive(data),
    target = archive.locate(itemPath);
  if (!target) throw new Error(`File not found: ${itemPath}`);
  const [name, entry] = target;
  let content = entry.data,
    media = guessMediaType(name);
  if (media === "application/octet-stream") {
    try {
      const [path, root] = archive.opf();
      media =
        manifestFromOpf(path, root).find((i) => i.member_path === name)
          ?.media_type || media;
    } catch {
      /* legacy tolerates absent manifest for assets. */
    }
  }
  if (isDocumentMediaType(media)) {
    content = encode(
      injectBase(
        stripScripts(
          new TextDecoder("utf-8", { ignoreBOM: true }).decode(content),
        ),
        baseHref,
      ),
    );
    media = "text/html; charset=utf-8";
  }
  return [content, media];
}
export function epubBaseHref(prefix: string, path: string): string {
  const base = prefix.endsWith("/") ? prefix : prefix + "/",
    parent = dirname(path.replace(/^\/+/, ""));
  return parent === "." || !parent
    ? base
    : `${base}${parent.replace(/^\/+|\/+$/g, "")}/`;
}
