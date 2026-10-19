import type { Metadata } from "./models";
import {
  basename,
  canonicalZipMember,
  dirname,
  extension,
  joinpath,
  normalizeEpubArchivePaths,
  relativeHref,
  writeArchive,
} from "./archive";
import type { ArchiveMember, ArchivePatch } from "./archive";
import { EpubArchive, guessImageMediaType, resolveOpfHref } from "./epub";
import type { CoverAsset } from "./epub";
import {
  appendElement,
  attr,
  child,
  children,
  DC_NS,
  OPF_NS,
  parseXml,
  removeElement,
  serializeElementTree,
} from "./xml";
import type { Element } from "./xml";
import { patchDocHtmlBinderyCss, stripWebpRefsFromHtml } from "./epub-html";
import { strip } from "./python";
const encode = (text: string) => new TextEncoder().encode(text);
function applyMetadata(
  root: Element,
  meta: Metadata,
  keepCover: boolean,
  coverId?: string,
): void {
  let metadata = child(root, "metadata");
  if (!metadata) {
    metadata = root.ownerDocument!.createElementNS(OPF_NS, "metadata");
    root.insertBefore(metadata, root.firstChild);
  }
  for (const node of children(metadata)) {
    const local = node.localName ?? "",
      prop = strip(attr(node, "property")),
      name = strip(attr(node, "name"));
    if (
      [
        "identifier",
        "title",
        "language",
        "creator",
        "description",
        "publisher",
        "date",
        "subject",
      ].includes(local) ||
      (local === "meta" &&
        (["dcterms:modified", "belongs-to-collection"].includes(prop) ||
          name === "rating" ||
          ((!keepCover || coverId) && name === "cover")))
    )
      removeElement(node);
  }
  const identifier = meta.identifier || meta.book_id;
  appendElement(
    metadata,
    DC_NS,
    "identifier",
    identifier.startsWith("urn:") ? identifier : `urn:uuid:${identifier}`,
  );
  appendElement(metadata, DC_NS, "title", meta.title);
  appendElement(metadata, DC_NS, "language", meta.language || "zh-CN");
  for (const [name, value] of [
    ["creator", meta.author],
    ["description", meta.description],
    ["publisher", meta.publisher],
    ["date", meta.published],
  ] as const)
    if (value) appendElement(metadata, DC_NS, name, value);
  if (meta.identifier)
    appendElement(metadata, DC_NS, "identifier", meta.identifier, {
      id: "identifier",
    });
  if (meta.series)
    appendElement(metadata, OPF_NS, "meta", meta.series, {
      property: "belongs-to-collection",
    });
  if (meta.isbn)
    appendElement(metadata, DC_NS, "identifier", meta.isbn, { id: "isbn" });
  for (const tag of meta.tags)
    if (tag) appendElement(metadata, DC_NS, "subject", tag);
  if (meta.rating !== null)
    appendElement(metadata, OPF_NS, "meta", String(meta.rating), {
      name: "rating",
    });
  appendElement(
    metadata,
    OPF_NS,
    "meta",
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    { property: "dcterms:modified" },
  );
  if (coverId)
    appendElement(metadata, OPF_NS, "meta", undefined, {
      name: "cover",
      content: coverId,
    });
}
function packageRoot(docs: string[]): string {
  if (!docs.length) return ".";
  const dirs = docs.map((d) => dirname(d).split("/"));
  const common: string[] = [];
  for (
    let i = 0;
    i < dirs[0].length && dirs.every((d) => d[i] === dirs[0][i]);
    i++
  )
    common.push(dirs[0][i]);
  let root = common.join("/") || ".";
  if (["text", "xhtml", "html"].includes(basename(root).toLowerCase()))
    root = dirname(root);
  return root;
}
export function stripWebpAssetsAndRefs(data: Uint8Array): ArchivePatch {
  const archive = new EpubArchive(data);
  let path: string;
  try {
    path = archive.opfPath();
  } catch {
    return { data, changed: false };
  }
  const entry = archive.entries.find(
    (e) => canonicalZipMember(e.name) === path,
  );
  if (!entry) return { data, changed: false };
  const root = parseXml(entry.data),
    manifest = child(root, "manifest");
  if (!manifest) return { data, changed: false };
  const remove = new Set<string>(),
    docs = new Set<string>();
  for (const item of children(manifest, "item")) {
    const href = strip(attr(item, "href")),
      media = strip(attr(item, "media-type")).toLowerCase();
    if (href && ["application/xhtml+xml", "text/html"].includes(media))
      docs.add(resolveOpfHref(path, href));
    if (href.toLowerCase().endsWith(".webp") || media === "image/webp") {
      if (href) remove.add(resolveOpfHref(path, href));
      removeElement(item);
    }
  }
  if (!remove.size) return { data, changed: false };
  const replacements = new Map([[path, serializeElementTree(root)]]);
  for (const e of archive.entries) {
    const name = canonicalZipMember(e.name);
    if (docs.has(name))
      replacements.set(
        name,
        encode(
          stripWebpRefsFromHtml(
            new TextDecoder("utf-8", { ignoreBOM: true }).decode(e.data),
          ),
        ),
      );
  }
  return {
    changed: true,
    data: normalizeEpubArchivePaths(
      rewrite(archive.entries, replacements, remove),
    ).data,
  };
}
function rewrite(
  entries: ArchiveMember[],
  replacements: Map<string, Uint8Array>,
  remove: Set<string> = new Set(),
): Uint8Array {
  const written = new Set<string>(),
    output: ArchiveMember[] = [];
  for (const e of [
    ...entries.filter((e) => canonicalZipMember(e.name) === "mimetype"),
    ...entries,
  ]) {
    const name = canonicalZipMember(e.name);
    if (
      !name ||
      written.has(name) ||
      (remove.has(name) && !replacements.has(name))
    )
      continue;
    output.push({
      name: name === "mimetype" ? name : e.name,
      data: replacements.get(name) ?? e.data,
    });
    written.add(name);
  }
  for (const [name, data] of replacements)
    if (!written.has(name)) output.push({ name, data });
  return writeArchive(output);
}
export interface UpdateOptions {
  cover?: CoverAsset | null;
  css_text?: string | null;
  strip_original_css?: boolean;
  strip_webp_assets?: boolean;
}
export function updateEpubMetadata(
  data: Uint8Array,
  meta: Metadata,
  options: UpdateOptions = {},
): Uint8Array {
  data = normalizeEpubArchivePaths(data).data;
  if (options.strip_webp_assets) data = stripWebpAssetsAndRefs(data).data;
  const archive = new EpubArchive(data);
  let path: string, root: Element;
  try {
    [path, root] = archive.opf();
  } catch {
    throw new Error("Failed to update EPUB metadata using zip/lxml pipeline");
  }
  const cover = options.cover,
    cssRequested = options.css_text != null,
    stripOriginal = options.strip_original_css ?? false;
  if (!cover && !cssRequested && !stripOriginal) {
    applyMetadata(root, meta, true);
    return normalizeEpubArchivePaths(
      rewrite(archive.entries, new Map([[path, serializeElementTree(root)]])),
    ).data;
  }
  const manifest = child(root, "manifest"),
    spine = child(root, "spine");
  if (!manifest)
    throw new Error("Failed to update EPUB metadata using zip/lxml pipeline");
  const items = children(manifest, "item"),
    byId = new Map(
      items
        .filter((i) => strip(attr(i, "id")))
        .map((i) => [strip(attr(i, "id")), i]),
    );
  const isDoc = (i: Element) =>
    ["application/xhtml+xml", "text/html"].includes(
      strip(attr(i, "media-type")).toLowerCase(),
    ) && !attr(i, "properties").split(/\s+/).includes("nav");
  let docItems = spine
    ? children(spine, "itemref").flatMap((ref) => {
        const item = byId.get(strip(attr(ref, "idref")));
        return item && isDoc(item) ? [item] : [];
      })
    : [];
  if (!docItems.length) docItems = items.filter(isDoc);
  const docs = docItems
    .map((i) => strip(attr(i, "href")))
    .filter(Boolean)
    .map((href) => resolveOpfHref(path, href));
  const replacements = new Map<string, Uint8Array>(),
    remove = new Set<string>();
  let cssMember: string | null = null;
  if (cssRequested || stripOriginal) {
    for (const item of items) {
      const id = attr(item, "id"),
        href = attr(item, "href"),
        name = basename(href).toLowerCase(),
        media = strip(attr(item, "media-type")).toLowerCase();
      if (
        ["bindery.css", "bindery-overlay.css"].includes(name) ||
        id.startsWith("bindery-css") ||
        (stripOriginal && media === "text/css")
      ) {
        if (strip(href)) remove.add(resolveOpfHref(path, strip(href)));
        removeElement(item);
      }
    }
    const css = strip(options.css_text || "");
    if (cssRequested && css) {
      cssMember = canonicalZipMember(
        joinpath(packageRoot(docs), "Styles/bindery.css"),
      );
      let id = "bindery-css",
        suffix = 1;
      while (byId.has(id)) id = `bindery-css-${suffix++}`;
      appendElement(manifest, OPF_NS, "item", undefined, {
        id,
        href: relativeHref(path, cssMember),
        "media-type": "text/css",
      });
      replacements.set(cssMember, encode(css));
    }
  }
  let coverId: string | undefined;
  if (cover) {
    const media = guessImageMediaType(cover.name);
    const existing = items.find(
      (i) =>
        attr(i, "properties").split(/\s+/).includes("cover-image") ||
        (strip(attr(i, "media-type")).toLowerCase().startsWith("image/") &&
          (attr(i, "id").toLowerCase().includes("cover") ||
            attr(i, "href").toLowerCase().includes("cover"))),
    );
    let member: string;
    if (existing) {
      coverId = strip(attr(existing, "id")) || "cover-image";
      const href =
        strip(attr(existing, "href")) ||
        `Images/cover${(extension(cover.name) || ".jpg").toLowerCase()}`;
      member = resolveOpfHref(path, href);
      existing.setAttribute("id", coverId);
      existing.setAttribute("href", relativeHref(path, member));
      existing.setAttribute("media-type", media);
      existing.setAttribute("properties", "cover-image");
    } else {
      member = canonicalZipMember(
        joinpath(
          packageRoot(docs),
          `Images/cover${extension(cover.name).toLowerCase() || ".jpg"}`,
        ),
      );
      coverId = "cover-image";
      let suffix = 1;
      while (byId.has(coverId)) coverId = `cover-image-${suffix++}`;
      appendElement(manifest, OPF_NS, "item", undefined, {
        id: coverId,
        href: relativeHref(path, member),
        "media-type": media,
        properties: "cover-image",
      });
    }
    replacements.set(member, cover.data);
  }
  applyMetadata(root, meta, !cover, coverId);
  replacements.set(path, serializeElementTree(root));
  if (cssRequested || stripOriginal)
    for (const e of archive.entries) {
      const name = canonicalZipMember(e.name);
      if (docs.includes(name))
        replacements.set(
          name,
          encode(
            patchDocHtmlBinderyCss(
              new TextDecoder("utf-8", { ignoreBOM: true }).decode(e.data),
              cssMember ? relativeHref(name, cssMember) : null,
              stripOriginal,
            ),
          ),
        );
    }
  return normalizeEpubArchivePaths(
    rewrite(archive.entries, replacements, remove),
  ).data;
}
