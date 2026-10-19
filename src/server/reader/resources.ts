import { DOMParser } from "@xmldom/xmldom";
import type { Node, Element } from "@xmldom/xmldom";
import { guessMediaType } from "../../core/epub";
import { encodeEpubPath, isSafeEpubPath, resolveEpubReference } from "../../core/epub-path";
import { escapeHtml } from "../../core/epub-html";
import { edgeRevalidateHeaders, HttpError, requireBook } from "../http";
import type { LibraryStorage } from "../storage";
import { readBookArchive } from "./service";

/** The router has already decoded exactly once. Never normalize or decode again. */
export function validateItemPath(raw: string, members: { has(path: string): boolean }): string {
  if (!isSafeEpubPath(raw) || !members.has(raw)) throw new HttpError(404, "资源不存在");
  return raw;
}

type ResourceUrl = (raw: string) => string | null;
function cssUnescape(value: string): string {
  return value.replace(/\\(?:([0-9a-f]{1,6})\s?|([^\r\n\f])|\r\n|[\r\n\f])/gi, (_match, hex: string | undefined, character: string | undefined) => {
    const point = hex ? parseInt(hex, 16) : 0;
    return hex ? String.fromCodePoint(point && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? point : 0xfffd) : character ?? "";
  });
}
/** Rewrite URLs in CSS tokens, leaving comments and unrelated quoted strings intact. */
export function rewriteBookCss(css: string, resolve: ResourceUrl): string {
  const string = `"(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'`;
  const tokens = new RegExp(`/\\*[\\s\\S]*?\\*/|@import\\s+(${string})|url\\(\\s*(${string}|(?:\\\\[\\s\\S]|[^\\)"'])*?)\\s*\\)|${string}`, "gi");
  return css.replace(tokens, (token, imported: string | undefined, url: string | undefined) => {
    if (imported === undefined && url === undefined) return token;
    const value = (imported ?? url!).trim(), raw = cssUnescape(/^["']/.test(value) ? value.slice(1, -1) : value);
    const target = /^data:/i.test(raw) ? raw : resolve(raw) ?? "";
    const quoted = JSON.stringify(target).replace(/</g, "\\3c ");
    return imported === undefined ? `url(${quoted})` : `@import ${quoted}`;
  });
}

// This filtering improves rendering and removes automatic navigation. The security
// boundary is the HTTP CSP + script-free iframe sandbox, not HTML parsing/regexes.
const drop = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "meta", "base", "noscript", "template", "form", "input", "button", "textarea", "select", "option", "audio", "video", "source", "track"]);
const allowed = new Set("html head body title style link article section header footer main nav aside div span p a abbr b bdi bdo blockquote br cite code col colgroup dd del details dfn dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol pre q rp rt ruby s samp small strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr svg g path image rect circle ellipse line polygon polyline text tspan defs use symbol lineargradient radialgradient stop clippath mask".split(" "));
const voids = new Set(["br", "hr", "img", "link", "wbr", "col"]);
const attributes = new Set("id class title lang dir style alt width height colspan rowspan scope start reversed type open role aria-label aria-hidden viewbox d fill stroke stroke-width x y x1 y1 x2 y2 cx cy r rx ry points transform preserveaspectratio offset stop-color clip-path".split(" "));

export function isolatedBookHtml(content: Uint8Array, baseHref: string, requestUrl: string, resolve?: ResourceUrl): string {
  const origin = new URL(requestUrl).origin, base = new URL(baseHref, origin);
  const prefix = base.pathname.split("/epub/")[0] + "/epub/";
  const safeUrl = (raw: string, image = false) => {
    if (!raw.trim()) return null;
    if (image && /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i.test(raw)) return raw;
    if (resolve) return resolve(raw);
    try {
      const resolved = new URL(raw, raw.startsWith("#") ? requestUrl : base);
      return resolved.origin === origin && resolved.pathname.startsWith(prefix) && !resolved.username && !resolved.password ? resolved.href : null;
    } catch { return null; }
  };
  const doc = new DOMParser({ onError: () => {} }).parseFromString(new TextDecoder().decode(content), "text/html");
  function renderAttributes(el: Element, tag: string): string {
    let attrs = tag === "link" ? ' rel="stylesheet"' : "";
    for (let i = 0; i < el.attributes.length; i++) {
      const attribute = el.attributes.item(i)!, name = attribute.name.toLowerCase();
      let value: string | null = attribute.value;
      if (name === "href" || name === "xlink:href" || name === "src") value = safeUrl(value, tag === "img" || tag === "image");
      else if (!attributes.has(name)) continue;
      else if (["style", "fill", "stroke", "clip-path"].includes(name) && resolve) value = rewriteBookCss(value, resolve);
      if (value !== null) attrs += ` ${name}="${escapeHtml(value)}"`;
    }
    return attrs;
  }
  function render(node: Node): string {
    if (node.nodeType === 3 || node.nodeType === 4) return escapeHtml(node.nodeValue || "");
    if (node.nodeType !== 1) return "";
    const el = node as Element, tag = (el.localName || el.tagName).toLowerCase();
    if (drop.has(tag)) return "";
    let body = "";
    for (let child = el.firstChild; child; child = child.nextSibling) body += render(child);
    if (!allowed.has(tag)) return body;
    if (tag === "html" || tag === "head" || tag === "body") return body;
    if (tag === "style") return `<style>${(resolve ? rewriteBookCss(el.textContent || "", resolve) : el.textContent || "").replace(/</g, "\\3c ")}</style>`;
    if (tag === "title") return "";
    if (tag === "link" && (el.getAttribute("rel") || "").toLowerCase() !== "stylesheet") return "";
    return `<${tag}${renderAttributes(el, tag)}>${voids.has(tag) ? "" : `${body}</${tag}>`}`;
  }
  const bodyElement = doc.getElementsByTagName("body")[0], headElement = doc.getElementsByTagName("head")[0];
  let body = "", head = "";
  if (bodyElement) {
    for (let node = bodyElement.firstChild; node; node = node.nextSibling) body += render(node);
    for (let node = headElement?.firstChild; node; node = node.nextSibling) head += render(node);
  } else for (let node = doc.firstChild; node; node = node.nextSibling) body += render(node);
  const htmlAttributes = doc.documentElement?.localName === "html" ? renderAttributes(doc.documentElement, "html") : "";
  return `<!doctype html><html${htmlAttributes}><head><meta charset="utf-8"><base href="${escapeHtml(base.href)}">${head}</head><body${bodyElement ? renderAttributes(bodyElement, "body") : ""}>${body}</body></html>`;
}

export function epubResource(request: Request, bookId: string, rawPath: string, library: LibraryStorage): Response {
  requireBook(bookId, library);
  const archive = readBookArchive(bookId, library), path = validateItemPath(rawPath, archive);
  let media = guessMediaType(path);
  if (media === "application/octet-stream") media = archive.mediaType(path) || media;
  return epubMemberResponse(request, `/book/${bookId}/epub/`, path, archive, archive.read(path)!, media, edgeRevalidateHeaders());
}

/** Reader and Kindle preview share exact URL resolution and the same isolation boundary. */
export function epubMemberResponse(
  request: Request, prefix: string, path: string, members: { has(path: string): boolean },
  content: Uint8Array, media: string, responseHeaders: HeadersInit,
): Response {
  const origin = new URL(request.url).origin;
  const baseHref = prefix + encodeEpubPath(path.split("/").slice(0, -1).join("/")) + (path.includes("/") ? "/" : "");
  const resourceUrl: ResourceUrl = raw => {
    const resolved = resolveEpubReference(path, raw, member => members.has(member));
    if (!resolved) return null;
    let fragment = resolved.fragment;
    try { fragment = decodeURIComponent(fragment); } catch { /* literal percent in an ID */ }
    return origin + prefix + encodeEpubPath(resolved.path) + (fragment ? `#${encodeURIComponent(fragment)}` : "");
  };
  if (media === "text/css") content = new TextEncoder().encode(rewriteBookCss(new TextDecoder().decode(content), resourceUrl));
  const headers = new Headers(responseHeaders);
  const source = new URL(prefix, request.url).href;
  headers.set("Content-Security-Policy", `sandbox allow-same-origin; default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${source}; img-src data: ${source}; font-src data: ${source}; media-src ${source}; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri ${source}; frame-ancestors 'self'`);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (media.toLowerCase().includes("html")) {
    content = new TextEncoder().encode(isolatedBookHtml(content, baseHref, request.url, resourceUrl));
    media = "text/html; charset=utf-8";
  } else if (media.startsWith("text/") && !media.includes("charset=")) media += "; charset=utf-8";
  headers.set("Content-Type", media);
  headers.set("Content-Length", String(content.byteLength));
  return new Response(request.method === "HEAD" ? null : content as BodyInit, { headers });
}
