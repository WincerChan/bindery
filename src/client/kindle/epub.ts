import { canonicalZipMember, relativeHref, writeArchive } from "../../core/archive";
import { EpubArchive, resolveOpfHref } from "../../core/epub";
import { appendStylesheetLink } from "../../core/epub-html";
import { appendElement, attr, child, children, OPF_NS, serializeElementTree } from "../../core/xml";
import { validateCss } from "../../core/css";

/** Append a separate stylesheet to a COPY. Keep library metadata, assets and all existing CSS. */
export function appendProfileCss(data: Uint8Array, css: string): Uint8Array<ArrayBuffer> {
  const error = validateCss(css); if (error) throw new Error(error);
  if (!css.trim()) return new Uint8Array(data);
  const archive = new EpubArchive(data), [opf, root] = archive.opf(), manifest = child(root, "manifest");
  if (!manifest) throw new Error("EPUB 缺少 manifest");
  let name = "bindery-kindle-profile.css", index = 1;
  const names = new Set(archive.entries.map(e => canonicalZipMember(e.name)));
  let member = resolveOpfHref(opf, name);
  while (names.has(member)) { name = `bindery-kindle-profile-${index++}.css`; member = resolveOpfHref(opf, name); }
  const ids = new Set(children(manifest, "item").map(i => attr(i, "id")));
  let id = "bindery-kindle-profile"; index = 1;
  while (ids.has(id)) id = `bindery-kindle-profile-${index++}`;
  const docs = new Set(children(manifest, "item").filter(i => ["application/xhtml+xml", "text/html"].includes(attr(i, "media-type"))).map(i => resolveOpfHref(opf, attr(i, "href"))));
  appendElement(manifest, OPF_NS, "item", undefined, { id, href: name, "media-type": "text/css" });
  const encoder = new TextEncoder();
  return new Uint8Array(writeArchive([...archive.entries.map(e => ({ name: e.name, data: canonicalZipMember(e.name) === opf ? serializeElementTree(root) : docs.has(canonicalZipMember(e.name)) ? encoder.encode(appendStylesheetLink(new TextDecoder().decode(e.data), relativeHref(canonicalZipMember(e.name), member))) : e.data })), { name: member, data: encoder.encode(css) }]));
}
