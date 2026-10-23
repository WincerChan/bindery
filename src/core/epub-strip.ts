import { XMLSerializer } from "@xmldom/xmldom";
import { canonicalZipMember, relativeHref, writeArchive, type ArchiveMember, type Deflater } from "./archive";
import { EpubArchive, epubCoverItem, extractCover, isDocumentMediaType, manifestFromOpf, resolveOpfHref, type EpubSource } from "./epub";
import { rewriteCssUrls, stripCss } from "./css-strip";
import { appendElement, attr, child, children, descendants, OPF_NS, parseXml, serializeElementTree } from "./xml";
import type { Element } from "./xml";

export interface EpubStripOptions { stripFonts?: boolean; stripImages?: boolean; stripPageMargins?: boolean; stripLineHeight?: boolean; stripParagraphSpacing?: boolean }
const stripRequested = (options: EpubStripOptions) => Boolean(options.stripFonts || options.stripImages || options.stripPageMargins || options.stripLineHeight || options.stripParagraphSpacing);
const fontFile = /\.(?:ttf|otf|woff2?)$/i;
const imageFile = /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|tiff?|ico|apng|jxl)$/i;
const fontMedia = /^(?:font\/|application\/(?:.*font.*|vnd\.ms-opentype))/i;
const remove = (node: Element) => node.parentNode?.removeChild(node);
const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
function resourcePath(from: string, href: string): string {
  if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href.trim())) return "";
  return resolveOpfHref(from, decode(href.trim().split(/[?#]/)[0]));
}

/** A reusable plan contains metadata and member names, never a whole EPUB copy. */
export function createEpubAssetStripper(
  archive: EpubSource, memberNames: Iterable<string>, options: EpubStripOptions,
  coverOverride?: string | null, resolve = resourcePath, onGrowth = (_bytes: number) => {},
) {
  const names = [...memberNames], namesSet = new Set(names), [opf, root] = archive.opf();
  const items = manifestFromOpf(opf, root, archive.resolve?.bind(archive));
  const candidate = epubCoverItem(items, root)?.member_path;
  const cover = coverOverride === undefined ? (candidate && namesSet.has(candidate) ? candidate : undefined) : coverOverride ?? undefined;
  const mediaTypes = new Map(items.map(item => [item.member_path, item.media_type]));
  const resourcePath = resolve;
  const images = new Set(items.filter(item => item.media_type.startsWith("image/")).map(item => resourcePath(opf, item.href)));
  const fonts = new Set(items.filter(item => fontMedia.test(item.media_type)).map(item => resourcePath(opf, item.href)));
  const removed = new Set(names.filter(name =>
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
  const guideCovers = new Set(children(child(root, "guide") ?? root, "reference").filter(ref => attr(ref, "type") === "cover").map(ref => resourcePath(opf, attr(ref, "href"))));
  const isImage = (from: string, url: string) => /^data:image\//i.test(url) || images.has(resourcePath(from, url)) || imageFile.test(url.split(/[?#]/)[0]);
  const css = (text: string, from: string, keepCover: boolean, pageRoot = false, heading = false) => stripCss(text, { ...options, pageRoot, heading, isImage: url => isImage(from, url) && !(keepCover && cover && resourcePath(from, url) === cover) });
  const encoder = new TextEncoder(), decoder = new TextDecoder(), serializer = new XMLSerializer();
  const coverStyles = new Map<string, string>(), coverSources = new Map<string, string>();
  const rewriteCoverCss = (text: string, from: string) => rewriteCssUrls(text, url => {
    const target = coverStyles.get(resourcePath(from, url));
    return target ? relativeHref(from, target).split("/").map(part => part === ".." ? part : encodeURIComponent(part)).join("/") : undefined;
  });
  let coverStylesReady = false;
  function prepareCoverStyles() {
    if (coverStylesReady || !options.stripImages) return;
    const sources = names.filter(name => styles.has(name) || /\.css$/i.test(name));
    const taken = new Set(names), ids = new Set(children(manifest!, "item").map(item => attr(item, "id")));
    const texts = new Map(sources.map(name => [name, css(decoder.decode(archive.read(name)!), name, true)]));
    let index = 0;
    const add = (name: string) => {
      let member: string, id: string;
      do { id = `bindery-kindle-cover-${++index}`; member = resolveOpfHref(name, `${id}.css`); } while (taken.has(member) || ids.has(id));
      taken.add(member); ids.add(id); coverStyles.set(name, member); coverSources.set(member, name);
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
    coverStylesReady = true;
    onGrowth([...coverSources].reduce((bytes, [name, source]) => bytes + 512 + (name.length + source.length) * 4, 0));
  }
  function coverDocument(name: string, doc: Element): boolean {
    const nodes = [doc, ...descendants(doc)];
    return Boolean(cover && (
      guideCovers.has(name) ||
      nodes.some(node => attr(node, "epub:type").split(/\s+/).includes("cover")) ||
      (nodes.some(node => ["img", "image"].includes(node.localName ?? "") && referencesCoverInDocument(name, node)) &&
        (!descendants(doc, "body")[0]?.textContent?.trim() || /(?:^|\/)cover\.[^/]+$/i.test(name)))
    ));
  }
  function referencesCoverInDocument(name: string, node: Element): boolean {
    return Boolean(cover && (
      ["src", "href", "xlink:href"].some(key => resourcePath(name, attr(node, key)) === cover) ||
      attr(node, "srcset").split(",").some(candidate => resourcePath(name, candidate.trim().split(/\s+/)[0]) === cover)
    ));
  }
  const document = (name: string) => docs.has(name) || /\.(?:xhtml|html?|svg)$/i.test(name);
  let packageReady = false;
  function packageDocument(): Uint8Array {
    // Only the package response needs to know whether any document uses cover CSS.
    // Normal chapter/asset requests never scan sibling documents.
    if (!packageReady && !coverStylesReady && cover && options.stripImages) {
      if ([...guideCovers].some(name => namesSet.has(name) && !removed.has(name) && document(name))) prepareCoverStyles();
      else for (const name of names) if (!removed.has(name) && document(name) && coverDocument(name, parseXml(archive.read(name)!))) {
        prepareCoverStyles(); break;
      }
      packageReady = true;
    }
    return serializeElementTree(root);
  }
  function transform(name: string, content: Uint8Array): Uint8Array | undefined {
    if (!stripRequested(options)) return content;
    if (removed.has(name)) return undefined;
    if (name === opf) return packageDocument();
    if (name === "META-INF/encryption.xml") {
      const encryption = parseXml(content);
      for (const node of descendants(encryption, "EncryptedData")) {
        if (descendants(node, "CipherReference").some(ref => removed.has(resourcePath("", attr(ref, "URI"))))) remove(node);
      }
      if (!descendants(encryption, "EncryptedData").length) return undefined;
      content = encoder.encode(serializer.serializeToString(encryption));
    } else if (styles.has(name) || /\.css$/i.test(name)) content = encoder.encode(css(decoder.decode(content), name, false));
    else if ((docs.has(name) || /\.(?:xhtml|html?|svg)$/i.test(name)) && !options.stripFonts && !options.stripImages) {
      // CSS-only options touch stylesheets, <style> blocks and style attributes; skip the DOM round trip.
      const original = decoder.decode(content);
      const text = original.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_match, open: string, body: string, close: string) => open + css(body, name, false) + close)
        .replace(/<([a-zA-Z][\w:-]*)\b[^>]*>/g, (tag: string, tagName: string) => {
          const localName = tagName.slice(tagName.lastIndexOf(":") + 1);
          return tag.replace(/(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/i, (_match, prefix: string, quote: string, value: string) => prefix + quote + css(value, name, false, /^(?:html|body)$/i.test(localName), /^h[1-6]$/i.test(localName)) + quote);
        });
      if (text !== original) content = encoder.encode(text);
    } else if (docs.has(name) || /\.(?:xhtml|html?|svg)$/i.test(name)) {
      const doc = parseXml(content), nodes = [doc, ...descendants(doc)];
      const coverPage = coverDocument(name, doc), referencesCover = (node: Element) => referencesCoverInDocument(name, node);
      if (coverPage) prepareCoverStyles();
      for (const node of nodes) {
        if (options.stripFonts) {
          node.removeAttribute("font-family");
          if (node.localName === "font") node.removeAttribute("face");
        }
        if (node.hasAttribute("style")) node.setAttribute("style", css(attr(node, "style"), name, coverPage, node.localName === "html" || node.localName === "body", /^h[1-6]$/i.test(node.localName ?? "")));
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
    return content;
  }
  const has = (name: string) => {
    if (!namesSet.has(name) && /(?:^|\/)bindery-kindle-cover-\d+\.css$/.test(name)) packageDocument();
    return !removed.has(name) && (namesSet.has(name) || coverSources.has(name));
  };
  const transformCoverStyle = (name: string, content: Uint8Array) => {
    const source = coverSources.get(name)!;
    return encoder.encode(rewriteCoverCss(css(decoder.decode(content), source, true), source));
  };
  return {
    opf,
    removed,
    transform,
    has,
    read(name: string): Uint8Array | undefined {
      if (!has(name)) return undefined;
      const content = archive.read(coverSources.get(name) ?? name);
      return content && (coverSources.has(name) ? transformCoverStyle(name, content) : transform(name, content));
    },
    mediaType: (name: string) => coverSources.has(name) ? "text/css" : mediaTypes.get(name),
    source: (name: string) => coverSources.get(name) ?? name,
    transformCoverStyle,
    additionalNames: () => coverSources.keys(),
    // The preview charges metadata/cover maps to the reader's bounded LRU.
    weight: () => names.reduce((bytes, name) => bytes + 192 + name.length * 12, 0) + serializeElementTree(root).byteLength * 2 + coverSources.size * 256,
  };
}

/** Shared by Kindle and Kobo transfer and the preview. Only the returned copy is changed; `deflate: null` stores members. */
export function stripEpubAssets(data: Uint8Array, options: EpubStripOptions, deflate?: Deflater | null): Uint8Array<ArrayBuffer> {
  if (!stripRequested(options)) return new Uint8Array(data);
  const archive = new EpubArchive(data);
  const stripper = createEpubAssetStripper(archive, archive.entries.map(entry => canonicalZipMember(entry.name)), options, options.stripImages ? extractCover(data)?.[1] ?? null : null);
  const entries: ArchiveMember[] = [];
  for (const entry of archive.entries) {
    const content = stripper.transform(canonicalZipMember(entry.name), entry.data);
    if (content) entries.push({ name: entry.name, data: content });
  }
  // A cover document can occur after the package entry in ZIP order.
  entries.find(entry => canonicalZipMember(entry.name) === stripper.opf)!.data = stripper.transform(stripper.opf, archive.read(stripper.opf)!)!;
  for (const name of stripper.additionalNames()) entries.push({ name, data: stripper.transformCoverStyle(name, archive.read(stripper.source(name))!) });
  return new Uint8Array(writeArchive(entries, deflate));
}
