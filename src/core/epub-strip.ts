import { XMLSerializer } from "@xmldom/xmldom";
import { canonicalZipMember, relativeHref, writeArchive, type ArchiveMember } from "./archive";
import { EpubArchive, extractCover, isDocumentMediaType, manifestFromOpf, resolveOpfHref } from "./epub";
import { rewriteCssUrls, stripCss } from "./css-strip";
import { appendElement, attr, child, children, descendants, OPF_NS, parseXml, serializeElementTree } from "./xml";
import type { Element } from "./xml";

export interface EpubStripOptions { stripFonts?: boolean; stripImages?: boolean }
const fontFile = /\.(?:ttf|otf|woff2?)$/i;
const imageFile = /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico|apng|jxl)$/i;
const fontMedia = /^(?:font\/|application\/(?:.*font.*|vnd\.ms-opentype))/i;
const remove = (node: Element) => node.parentNode?.removeChild(node);
const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
function resourcePath(from: string, href: string): string {
  if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href.trim())) return "";
  return resolveOpfHref(from, decode(href.trim().split(/[?#]/)[0]));
}

/** Shared by Kindle transfer and preview. Only the returned copy is changed. */
export function stripEpubAssets(data: Uint8Array, options: EpubStripOptions): Uint8Array<ArrayBuffer> {
  if (!options.stripFonts && !options.stripImages) return new Uint8Array(data);
  const archive = new EpubArchive(data), [opf, root] = archive.opf(), items = manifestFromOpf(opf, root);
  const cover = options.stripImages ? extractCover(data)?.[1] : undefined;
  const images = new Set(items.filter(item => item.media_type.startsWith("image/")).map(item => resourcePath(opf, item.href)));
  const fonts = new Set(items.filter(item => fontMedia.test(item.media_type)).map(item => resourcePath(opf, item.href)));
  const removed = new Set(archive.entries.map(entry => canonicalZipMember(entry.name)).filter(name =>
    (options.stripFonts && (fontFile.test(name) || fonts.has(name))) ||
    (options.stripImages && name !== cover && (imageFile.test(name) || images.has(name))),
  ));
  const manifest = child(root, "manifest");
  if (!manifest) throw new Error("EPUB 缺少 manifest");
  const removedIds = new Set<string>();
  for (const item of children(manifest, "item")) {
    const path = resourcePath(opf, attr(item, "href"));
    if (removed.has(path) || (options.stripFonts && fontMedia.test(attr(item, "media-type"))) || (options.stripImages && path !== cover && attr(item, "media-type").startsWith("image/"))) {
      removedIds.add(attr(item, "id")); remove(item);
    }
  }
  for (const node of descendants(root)) {
    if (node.localName === "itemref" && removedIds.has(attr(node, "idref"))) remove(node);
    for (const attribute of ["fallback", "media-overlay"]) if (removedIds.has(attr(node, attribute))) node.removeAttribute(attribute);
  }
  const docs = new Set(items.filter(item => isDocumentMediaType(item.media_type)).map(item => resourcePath(opf, item.href)));
  const styles = new Set(items.filter(item => item.media_type === "text/css").map(item => resourcePath(opf, item.href)));
  const isImage = (from: string, url: string) => /^data:image\//i.test(url) || images.has(resourcePath(from, url)) || imageFile.test(url.split(/[?#]/)[0]);
  const css = (text: string, from: string, keepCover: boolean) => stripCss(text, { ...options, isImage: url => isImage(from, url) && !(keepCover && cover && resourcePath(from, url) === cover) });
  const encoder = new TextEncoder(), decoder = new TextDecoder(), serializer = new XMLSerializer();
  const coverStyles = new Map<string, string>(), coverEntries: ArchiveMember[] = [];
  const rewriteCoverCss = (text: string, from: string) => rewriteCssUrls(text, url => {
    const target = coverStyles.get(resourcePath(from, url));
    return target ? relativeHref(from, target).split("/").map(part => part === ".." ? part : encodeURIComponent(part)).join("/") : undefined;
  });
  let coverStylesReady = false;
  function prepareCoverStyles() {
    if (coverStylesReady || !options.stripImages) return;
    coverStylesReady = true;
    const sources = archive.entries.filter(entry => styles.has(canonicalZipMember(entry.name)) || /\.css$/i.test(entry.name));
    const names = new Set(archive.entries.map(entry => canonicalZipMember(entry.name))), ids = new Set(children(manifest!, "item").map(item => attr(item, "id")));
    const texts = new Map(sources.map(entry => [canonicalZipMember(entry.name), css(decoder.decode(entry.data), canonicalZipMember(entry.name), true)]));
    let index = 0;
    const add = (name: string) => {
      let member: string, id: string;
      do { id = `bindery-kindle-cover-${++index}`; member = resolveOpfHref(name, `${id}.css`); } while (names.has(member) || ids.has(id));
      names.add(member); ids.add(id); coverStyles.set(name, member);
      appendElement(manifest!, OPF_NS, "item", undefined, { id, href: relativeHref(opf, member), "media-type": "text/css" });
    };
    // Shared stylesheets lose every image in body chapters. Cover pages get a variant only
    // where a cover URL (or a transitive @import of one) needs to survive.
    for (const [name, text] of texts) if (text !== css(text, name, false)) add(name);
    let added: boolean;
    do {
      added = false;
      for (const [name, text] of texts) if (!coverStyles.has(name) && rewriteCoverCss(text, name) !== text) { add(name); added = true; }
    } while (added);
    for (const [name, member] of coverStyles) coverEntries.push({ name: member, data: encoder.encode(rewriteCoverCss(texts.get(name)!, name)) });
  }
  const entries: ArchiveMember[] = [];
  for (const entry of archive.entries) {
    const name = canonicalZipMember(entry.name);
    if (removed.has(name)) continue;
    let content = entry.data;
    if (name === "META-INF/encryption.xml") {
      const encryption = parseXml(content);
      for (const node of descendants(encryption, "EncryptedData")) {
        if (descendants(node, "CipherReference").some(ref => removed.has(resourcePath("", attr(ref, "URI"))))) remove(node);
      }
      if (!descendants(encryption, "EncryptedData").length) continue;
      content = encoder.encode(serializer.serializeToString(encryption));
    } else if (styles.has(name) || /\.css$/i.test(name)) content = encoder.encode(css(decoder.decode(content), name, false));
    else if (docs.has(name) || /\.(?:xhtml|html?|svg)$/i.test(name)) {
      const doc = parseXml(content), nodes = [doc, ...descendants(doc)];
      // A cover reference is retained even in SVG / picture based cover pages.
      const referencesCover = (node: Element) => Boolean(cover && (
        ["src", "href", "xlink:href"].some(key => resourcePath(name, attr(node, key)) === cover) ||
        attr(node, "srcset").split(",").some(candidate => resourcePath(name, candidate.trim().split(/\s+/)[0]) === cover)
      ));
      const coverPage = Boolean(cover && (
        children(child(root, "guide") ?? root, "reference").some(ref => attr(ref, "type") === "cover" && resourcePath(opf, attr(ref, "href")) === name) ||
        nodes.some(node => attr(node, "epub:type").split(/\s+/).includes("cover")) ||
        (nodes.some(node => ["img", "image"].includes(node.localName ?? "") && referencesCover(node)) &&
          (!descendants(doc, "body")[0]?.textContent?.trim() || /(?:^|\/)cover\.[^/]+$/i.test(name)))
      ));
      if (coverPage) prepareCoverStyles();
      for (const node of nodes) {
        if (options.stripFonts) {
          node.removeAttribute("font-family");
          if (node.localName === "font") node.removeAttribute("face");
        }
        if (node.hasAttribute("style")) node.setAttribute("style", css(attr(node, "style"), name, coverPage));
        if (node.localName === "style") {
          const stripped = css(node.textContent ?? "", name, coverPage);
          node.textContent = coverPage ? rewriteCoverCss(stripped, name) : stripped;
        }
        if (coverPage && node.localName === "link" && attr(node, "rel").split(/\s+/).includes("stylesheet")) {
          const target = coverStyles.get(resourcePath(name, attr(node, "href")));
          if (target) node.setAttribute("href", relativeHref(name, target));
        }
        if (!options.stripImages) continue;
        if (coverPage && node.localName === "picture" && descendants(node, "source").some(referencesCover) && !descendants(node, "img").some(referencesCover)) {
          appendElement(node, node.namespaceURI ?? "http://www.w3.org/1999/xhtml", "img", undefined, { src: relativeHref(name, cover!), alt: "" });
        }
        if (["img", "image", "source"].includes(node.localName ?? "")) {
          if (coverPage && node.localName !== "source" && referencesCover(node)) {
            if (node.localName === "img") node.setAttribute("src", relativeHref(name, cover!));
            node.removeAttribute("srcset"); continue;
          }
          remove(node);
        }
        for (const key of ["poster", "background"]) if (node.hasAttribute(key) && !(coverPage && resourcePath(name, attr(node, key)) === cover)) node.removeAttribute(key);
        if (["object", "embed", "input"].includes(node.localName ?? "") && (attr(node, "type").startsWith("image") || isImage(name, attr(node, "data") || attr(node, "src")))) remove(node);
      }
      if (options.stripImages) for (const node of nodes.reverse()) {
        const hasContent = descendants(node).some(el => ["img", "image", "path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "use", "text", "foreignObject"].includes(el.localName ?? ""));
        if ((node.localName === "svg" || (["figure", "picture"].includes(node.localName ?? "") && !node.textContent?.trim())) && !hasContent) remove(node);
      }
      // XMLSerializer retains the default XHTML namespace, so browser HTML parsing and boko agree.
      content = encoder.encode(serializer.serializeToString(doc));
    }
    entries.push({ name: entry.name, data: content });
  }
  const packageEntry = entries.find(entry => canonicalZipMember(entry.name) === opf)!;
  packageEntry.data = serializeElementTree(root);
  return new Uint8Array(writeArchive([...entries, ...coverEntries]));
}
