import { DOMParser } from "@xmldom/xmldom";
import type { Node, Element } from "@xmldom/xmldom";
import { epubBaseHref, loadEpubItem } from "../../core/epub";
import { escapeHtml } from "../../core/epub-html";
import { edgeRevalidateHeaders, HttpError, requireBook } from "../http";
import type { LibraryStorage } from "../storage";
import { readBookEpub } from "./service";

/** Validate after the router's decoding; also reject residual/double encodings. */
export function validateItemPath(raw: string): string {
  if (!raw || raw.length > 4096 || /[%\\\x00-\x1f\x7f?#:]/.test(raw) || raw.startsWith("/") || raw.split("/").some(part => !part || part === "." || part === "..")) {
    throw new HttpError(404, "资源不存在");
  }
  return raw;
}

// This filtering improves rendering and removes automatic navigation. The security
// boundary is the HTTP CSP + script-free iframe sandbox, not HTML parsing/regexes.
const drop = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "meta", "base", "noscript", "template", "form", "input", "button", "textarea", "select", "option", "audio", "video", "source", "track"]);
const allowed = new Set("html head body title style link article section header footer main nav aside div span p a abbr b bdi bdo blockquote br cite code col colgroup dd del details dfn dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol pre q rp rt ruby s samp small strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr svg g path image rect circle ellipse line polygon polyline text tspan defs use symbol lineargradient radialgradient stop clippath mask".split(" "));
const voids = new Set(["br", "hr", "img", "link", "wbr", "col"]);
const attributes = new Set("id class title lang dir style alt width height colspan rowspan scope start reversed type open role aria-label aria-hidden viewbox d fill stroke stroke-width x y x1 y1 x2 y2 cx cy r rx ry points transform preserveaspectratio offset stop-color clip-path".split(" "));

export function isolatedBookHtml(content: Uint8Array, baseHref: string, requestUrl: string): string {
  const origin = new URL(requestUrl).origin, base = new URL(baseHref, origin);
  const prefix = base.pathname.split("/epub/")[0] + "/epub/";
  const safeUrl = (raw: string, image = false) => {
    if (!raw.trim()) return null;
    if (image && /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i.test(raw)) return raw;
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
    if (tag === "style") return `<style>${(el.textContent || "").replace(/</g, "\\3c ")}</style>`;
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
  const path = validateItemPath(rawPath), data = readBookEpub(bookId, library);
  const baseHref = epubBaseHref(`/book/${bookId}/epub/`, path);
  let content: Uint8Array, media: string;
  try { [content, media] = loadEpubItem(data, path, baseHref); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("File not found:")) throw new HttpError(404, "资源不存在");
    throw error;
  }
  const headers = new Headers(edgeRevalidateHeaders());
  const source = new URL(`/book/${bookId}/epub/`, request.url).href;
  headers.set("Content-Security-Policy", `sandbox allow-same-origin; default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${source}; img-src data: ${source}; font-src data: ${source}; media-src ${source}; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri ${source}; frame-ancestors 'self'`);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (media.toLowerCase().includes("html")) {
    content = new TextEncoder().encode(isolatedBookHtml(content, baseHref, request.url));
    media = "text/html; charset=utf-8";
  } else if (media.startsWith("text/") && !media.includes("charset=")) media += "; charset=utf-8";
  headers.set("Content-Type", media);
  headers.set("Content-Length", String(content.byteLength));
  return new Response(request.method === "HEAD" ? null : content as BodyInit, { headers });
}
