import { canonicalZipMember, relativeHref, writeArchive, type Deflater } from "./archive";
import { EpubArchive, resolveOpfHref } from "./epub";
import { appendStylesheetLink } from "./epub-html";
import { appendElement, attr, child, children, OPF_NS, serializeElementTree } from "./xml";
import { validateCss } from "./css";
import { stripEpubAssets } from "./epub-strip";
import { generateProfileCss, isDefaultSettings, profileSettings, type TypesettingProfile } from "../client/devices/profiles";

/** Strip the profile's assets, then append its CSS. Default settings return the input bytes unchanged. */
export function applyTypesettingProfile(data: Uint8Array, profile: TypesettingProfile, deflate?: Deflater | null): Uint8Array<ArrayBuffer> {
  const settings = profileSettings(profile.settings);
  if (isDefaultSettings(settings)) return new Uint8Array(data);
  return appendProfileCss(stripEpubAssets(data, settings, deflate), generateProfileCss(profile), deflate);
}

/** Append a separate stylesheet to a COPY. Keep library metadata, assets and all existing CSS. */
export function appendProfileCss(data: Uint8Array, css: string, deflate?: Deflater | null): Uint8Array<ArrayBuffer> {
  const error = validateCss(css); if (error) throw new Error(error);
  if (!css.trim()) return new Uint8Array(data);
  const archive = new EpubArchive(data), [opf, root] = archive.opf(), manifest = child(root, "manifest");
  if (!manifest) throw new Error("EPUB 缺少 manifest");
  let name = "bindery-profile.css", index = 1;
  const names = new Set(archive.entries.map(e => canonicalZipMember(e.name)));
  let member = resolveOpfHref(opf, name);
  while (names.has(member)) { name = `bindery-profile-${index++}.css`; member = resolveOpfHref(opf, name); }
  const ids = new Set(children(manifest, "item").map(i => attr(i, "id")));
  let id = "bindery-profile"; index = 1;
  while (ids.has(id)) id = `bindery-profile-${index++}`;
  const docs = new Set(children(manifest, "item").filter(i => ["application/xhtml+xml", "text/html"].includes(attr(i, "media-type"))).map(i => resolveOpfHref(opf, attr(i, "href"))));
  appendElement(manifest, OPF_NS, "item", undefined, { id, href: name, "media-type": "text/css" });
  const encoder = new TextEncoder();
  return new Uint8Array(writeArchive([...archive.entries.map(e => ({ name: e.name, data: canonicalZipMember(e.name) === opf ? serializeElementTree(root) : docs.has(canonicalZipMember(e.name)) ? encoder.encode(appendStylesheetLink(new TextDecoder().decode(e.data), relativeHref(canonicalZipMember(e.name), member))) : e.data })), { name: member, data: encoder.encode(css) }], deflate));
}
