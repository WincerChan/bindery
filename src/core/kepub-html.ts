/**
 * Streaming KEPUB content transformer.
 *
 * This is a port of kepubify v4.0.4's default `TransformContent` behaviour. It
 * tokenizes XHTML/HTML5 and emits the polyglot output as it goes. No document
 * tree is retained: the element stack only holds the open elements, so a
 * 21 MB, 2241-member EPUB stays well below the DOM-parser cost.
 */
import { KEPUB_ENTITIES } from "./kepub-entities";

type Namespace = "html" | "svg" | "math";

interface Attr { name: string; value: string }
type Token =
  | { type: "text"; data: string; raw: boolean }
  | { type: "start"; name: string; attrs: Attr[]; selfClosing: boolean }
  | { type: "end"; name: string }
  | { type: "comment"; data: string }
  | { type: "doctype"; raw: string }
  | { type: "xml"; raw: string };

const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
const rawElements = new Set(["iframe", "noembed", "noframes", "noscript", "plaintext", "script", "style", "textarea", "title", "xmp"]);
const rcdataElements = new Set(["title", "textarea"]);
const skipSpanElements = new Set(["script", "style", "pre", "audio", "video", "svg", "math"]);
const paragraphElements = new Set(["p", "ol", "ul", "table", "h1", "h2", "h3", "h4", "h5", "h6"]);
const blockClosesParagraph = new Set(["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"]);
const pScopeStops = new Set(["button", "caption", "html", "table", "td", "th", "marquee", "object", "applet", "template"]);
function escapeText(text: string): string {
  let first = -1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 38 || code === 39 || code === 60 || code === 62 || code === 34 || code === 13 || code === 160) { first = i; break; }
  }
  if (first < 0) return text;
  let out = text.slice(0, first), at = first;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    let replacement = "";
    if (code === 38) replacement = "&amp;";
    else if (code === 39) replacement = "&#39;";
    else if (code === 60) replacement = "&lt;";
    else if (code === 62) replacement = "&gt;";
    else if (code === 34) replacement = "&#34;";
    else if (code === 13) replacement = "&#13;";
    else if (code === 160) replacement = "&#160;";
    if (replacement) { out += replacement; at++; }
    else {
      const next = text.slice(at).search(/[&'<>"\r\u00a0]/);
      if (next < 0) { out += text.slice(at); break; }
      out += text.slice(at, at + next); at += next;
    }
  }
  return out;
}
const escapeAttr = escapeText;
const escapeComment = (text: string) => {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "&") out += "&amp;";
    else if (ch === ">" && (i === 0 || text[i - 1] === "!" || text[i - 1] === "-")) out += "&gt;";
    else out += ch;
  }
  return out;
};

const svgTags: Record<string, string> = {
  altglyph: "altGlyph", altglyphdef: "altGlyphDef", altglyphitem: "altGlyphItem", animatecolor: "animateColor",
  animatemotion: "animateMotion", animatetransform: "animateTransform", clippath: "clipPath", feblend: "feBlend",
  fecolormatrix: "feColorMatrix", fecomponenttransfer: "feComponentTransfer", fecomposite: "feComposite",
  feconvolvematrix: "feConvolveMatrix", fediffuselighting: "feDiffuseLighting", fedisplacementmap: "feDisplacementMap",
  fedistantlight: "feDistantLight", feflood: "feFlood", fefunca: "feFuncA", fefuncb: "feFuncB", fefuncg: "feFuncG",
  fefuncr: "feFuncR", fegaussianblur: "feGaussianBlur", feimage: "feImage", femerge: "feMerge", femergenode: "feMergeNode",
  femorphology: "feMorphology", feoffset: "feOffset", fepointlight: "fePointLight", fespecularlighting: "feSpecularLighting",
  fespotlight: "feSpotLight", fetile: "feTile", feturbulence: "feTurbulence", foreignobject: "foreignObject",
  glyphref: "glyphRef", lineargradient: "linearGradient", radialgradient: "radialGradient", textpath: "textPath",
};
const svgAttrs: Record<string, string> = {
  attributename: "attributeName", attributetype: "attributeType", basefrequency: "baseFrequency", baseprofile: "baseProfile",
  calcmode: "calcMode", clippathunits: "clipPathUnits", diffuseconstant: "diffuseConstant", edgemode: "edgeMode",
  filterunits: "filterUnits", glyphref: "glyphRef", gradienttransform: "gradientTransform", gradientunits: "gradientUnits",
  kernelmatrix: "kernelMatrix", kernelunitlength: "kernelUnitLength", keypoints: "keyPoints", keysplines: "keySplines",
  keytimes: "keyTimes", lengthadjust: "lengthAdjust", limitingconeangle: "limitingConeAngle", markerheight: "markerHeight",
  markerunits: "markerUnits", markerwidth: "markerWidth", maskcontentunits: "maskContentUnits", maskunits: "maskUnits",
  numoctaves: "numOctaves", pathlength: "pathLength", patterncontentunits: "patternContentUnits", patterntransform: "patternTransform",
  patternunits: "patternUnits", pointsatx: "pointsAtX", pointsaty: "pointsAtY", pointsatz: "pointsAtZ", preservealpha: "preserveAlpha",
  preserveaspectratio: "preserveAspectRatio", primitiveunits: "primitiveUnits", refx: "refX", refy: "refY", repeatcount: "repeatCount",
  repeatdur: "repeatDur", requiredextensions: "requiredExtensions", requiredfeatures: "requiredFeatures", specularconstant: "specularConstant",
  specularexponent: "specularExponent", spreadmethod: "spreadMethod", startoffset: "startOffset", stddeviation: "stdDeviation",
  stitchtiles: "stitchTiles", surfacescale: "surfaceScale", systemlanguage: "systemLanguage", tablevalues: "tableValues", targetx: "targetX",
  targety: "targetY", textlength: "textLength", viewbox: "viewBox", viewtarget: "viewTarget", xchannelselector: "xChannelSelector",
  ychannelselector: "yChannelSelector", zoomandpan: "zoomAndPan",
};
const mathAttrs: Record<string, string> = { definitionurl: "definitionURL" };
const foreignAttrs: Record<string, string> = { "xlink:actuate": "xlink:actuate", "xlink:arcrole": "xlink:arcrole", "xlink:href": "xlink:href", "xlink:role": "xlink:role", "xlink:show": "xlink:show", "xlink:title": "xlink:title", "xlink:type": "xlink:type", "xml:lang": "xml:lang", "xml:space": "xml:space", xmlns: "xmlns", "xmlns:xlink": "xmlns:xlink" };

function decodeEntities(text: string, attribute = false): string {
  if (!text.includes("&")) return text;
  let out = "", at = 0;
  while (at < text.length) {
    const amp = text.indexOf("&", at);
    if (amp < 0) { out += text.slice(at); break; }
    out += text.slice(at, amp);
    let end = amp + 1;
    let name = "", semicolon = false, replacement: string | undefined;
    if (text[amp + 1] === "#") {
      end = amp + 2;
      if (text[end] === "x" || text[end] === "X") end++;
      while (end < text.length && /[0-9A-Fa-f]/.test(text[end])) end++;
      if (text[end] === ";") { semicolon = true; end++; }
      name = text.slice(amp + 1, end - (semicolon ? 1 : 0));
      const hex = name[1]?.toLowerCase() === "x";
      const value = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(value)) {
        let code = value;
        if (code >= 0x80 && code <= 0x9f) code = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"[code - 0x80].codePointAt(0)!;
        else if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) code = 0xfffd;
        replacement = String.fromCodePoint(code);
      }
    } else {
      while (end < text.length && end - amp <= 32 && /[0-9A-Za-z]/.test(text[end])) end++;
      name = text.slice(amp + 1, end);
      if (text[end] === ";") { semicolon = true; name += ";"; end++; }
      if (!name) { out += "&"; at = amp + 1; continue; }
      if (!semicolon && attribute && text[end] === "=") replacement = undefined;
      else replacement = KEPUB_ENTITIES[name];
      if (replacement === undefined && !semicolon) {
        for (let length = name.length - 1; length > 0; length--) {
          const legacy = KEPUB_ENTITIES[name.slice(0, length)];
          if (legacy !== undefined) { replacement = legacy; end = amp + 1 + length; break; }
        }
      }
    }
    if (replacement === undefined) { out += "&"; at = amp + 1; continue; }
    out += replacement; at = end;
  }
  return out;
}

class Tokenizer {
  private at = 0;
  private rawTag: string | null = null;
  private readonly text: string;
  constructor(source: string) {
    this.text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\0/g, "\uFFFD");
  }
  private readTagName(start: number): [string, number] {
    let at = start;
    while (at < this.text.length && !/[\s/>]/.test(this.text[at])) at++;
    return [this.text.slice(start, at).toLowerCase(), at];
  }
  private readStart(open: number): Token {
    let at = open + 1;
    const [name, afterName] = this.readTagName(at);
    at = afterName;
    const attrs: Attr[] = [];
    let selfClosing = false;
    for (;;) {
      while (at < this.text.length && /[\s]/.test(this.text[at])) at++;
      if (at >= this.text.length) break;
      if (this.text[at] === ">") { at++; break; }
      if (this.text[at] === "/" && this.text[at + 1] === ">") { selfClosing = true; at += 2; break; }
      if (this.text[at] === "/") { at++; continue; }
      const nameStart = at;
      while (at < this.text.length && !/[\s=/>]/.test(this.text[at])) at++;
      let attrName = this.text.slice(nameStart, at).toLowerCase();
      if (!attrName) { at++; continue; }
      while (at < this.text.length && /\s/.test(this.text[at])) at++;
      let value = "";
      if (this.text[at] === "=") {
        at++;
        while (at < this.text.length && /\s/.test(this.text[at])) at++;
        const quote = this.text[at];
        if (quote === '"' || quote === "'") {
          at++;
          const end = this.text.indexOf(quote, at);
          value = this.text.slice(at, end < 0 ? this.text.length : end);
          at = end < 0 ? this.text.length : end + 1;
        } else {
          const valueStart = at;
          while (at < this.text.length && !/[\s>]/.test(this.text[at])) {
            if (this.text[at] === "/" && this.text[at + 1] === ">") break;
            at++;
          }
          value = this.text.slice(valueStart, at);
        }
      }
      if (!attrs.some(attr => attr.name === attrName)) attrs.push({ name: attrName, value: decodeEntities(value, true) });
    }
    this.at = at;
    if (!selfClosing && rawElements.has(name)) this.rawTag = name;
    return { type: "start", name, attrs, selfClosing };
  }
  private readRaw(): Token | null {
    const tag = this.rawTag!;
    this.rawTag = null;
    if (tag === "plaintext") {
      const data = this.text.slice(this.at); this.at = this.text.length;
      return { type: "text", data, raw: true };
    }
    const lower = this.text.toLowerCase();
    let from = this.at;
    let close = -1;
    while (from <= this.text.length) {
      const found = lower.indexOf("</" + tag, from);
      if (found < 0) break;
      const after = this.text[found + 2 + tag.length];
      if (after === undefined || /[\s/>]/.test(after)) { close = found; break; }
      from = found + 2;
    }
    if (close < 0) {
      const data = this.text.slice(this.at); this.at = this.text.length;
      return data ? { type: "text", data: rcdataElements.has(tag) ? decodeEntities(data) : data, raw: !rcdataElements.has(tag) } : null;
    }
    const data = this.text.slice(this.at, close);
    this.at = close;
    if (!data) return null;
    return { type: "text", data: rcdataElements.has(tag) ? decodeEntities(data) : data, raw: !rcdataElements.has(tag) };
  }
  next(): Token | null {
    if (this.rawTag) {
      const token = this.readRaw();
      if (token) return token;
    }
    if (this.at >= this.text.length) return null;
    if (this.at === 0 && this.text.startsWith("<?xml", this.at)) {
      const end = this.text.indexOf("?>", this.at + 5);
      if (end >= 0) { const raw = this.text.slice(this.at, end + 2); this.at = end + 2; return { type: "xml", raw }; }
    }
    if (this.text[this.at] !== "<") {
      const next = this.text.indexOf("<", this.at);
      const end = next < 0 ? this.text.length : next;
      const data = decodeEntities(this.text.slice(this.at, end));
      this.at = end;
      return { type: "text", data, raw: false };
    }
    if (this.text.startsWith("<!--", this.at)) {
      const start = this.at + 4, end = this.text.indexOf("-->", start);
      this.at = end < 0 ? this.text.length : end + 3;
      return { type: "comment", data: this.text.slice(start, end < 0 ? this.text.length : end) };
    }
    if (this.text.startsWith("<![CDATA[", this.at)) {
      const start = this.at + 9, end = this.text.indexOf("]]>", start);
      this.at = end < 0 ? this.text.length : end + 3;
      return { type: "text", data: this.text.slice(start, end < 0 ? this.text.length : end), raw: true };
    }
    if (/^<!doctype/i.test(this.text.slice(this.at, this.at + 10))) {
      let at = this.at + 9, quote = "";
      while (at < this.text.length) {
        const ch = this.text[at++];
        if (quote) { if (ch === quote) quote = ""; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === ">") break;
      }
      const raw = this.text.slice(this.at, at); this.at = at;
      return { type: "doctype", raw };
    }
    if (this.text.startsWith("<!", this.at)) {
      const end = this.text.indexOf(">", this.at + 2);
      const data = this.text.slice(this.at + 2, end < 0 ? this.text.length : end);
      this.at = end < 0 ? this.text.length : end + 1;
      return { type: "comment", data };
    }
    if (this.text.startsWith("<?", this.at)) {
      const end = this.text.indexOf("?>", this.at + 2);
      const inner = this.text.slice(this.at + 2, end < 0 ? this.text.length : end);
      this.at = end < 0 ? this.text.length : end + 2;
      return { type: "comment", data: `?${inner}?` };
    }
    if (this.text[this.at + 1] === "/") {
      const [name, after] = this.readTagName(this.at + 2);
      let at = after;
      while (at < this.text.length && this.text[at] !== ">") at++;
      this.at = at < this.text.length ? at + 1 : at;
      return { type: "end", name };
    }
    const next = this.text[this.at + 1];
    if (next && /[A-Za-z]/.test(next)) return this.readStart(this.at);
    const end = this.text.indexOf("<", this.at + 1);
    const data = decodeEntities(this.text.slice(this.at, end < 0 ? this.text.length : end));
    this.at = end < 0 ? this.text.length : end;
    return { type: "text", data, raw: false };
  }
}

export interface KepubContentResult { html: string; sawKoboSpans: boolean }

/** Split a text node exactly like kepubify's zero-allocation sentence state machine. */
export function splitKepubSentences(value: string, sentences: string[] = []): string[] {
  let str = value, i = 0, state = 0;
  while (state !== -1) {
    let size = 0, input: number;
    if (i >= str.length) input = 5; // InputEOS
    else {
      const code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) size = 2;
      else size = 1;
      if (code === 0xfffd) input = 4;
      else if (code === 46 || code === 33 || code === 63) input = 0;
      else if (code === 39 || code === 34 || code === 0x201d || code === 0x2019 || code === 0x201c || code === 0x2026) input = 1;
      else if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32) input = 2;
      else input = 3;
    }
    let output = 0;
    switch (state) {
      case 0:
        if (input === 0) { output = 0; state = 1; }
        else if (input === 5) { output = 2; state = -1; }
        else { output = 0; state = 0; }
        break;
      case 1:
        if (input === 0) { output = 0; state = 1; }
        else if (input === 1) { output = 0; state = 2; }
        else if (input === 2) { output = 0; state = 3; }
        else if (input === 5) { output = 2; state = -1; }
        else { output = 0; state = 0; }
        break;
      case 2:
        if (input === 0) { output = 0; state = 1; }
        else if (input === 2) { output = 0; state = 3; }
        else if (input === 5) { output = 2; state = -1; }
        else { output = 0; state = 0; }
        break;
      case 3:
        if (input === 0) { output = 1; state = 1; }
        else if (input === 2) { output = 0; state = 3; }
        else if (input === 5) { output = 2; state = -1; }
        else { output = 1; state = 0; }
        break;
    }
    if (output === 0) i += size;
    else if (output === 1) { sentences.push(str.slice(0, i)); str = str.slice(i); i = size; }
    else {
      if (str.length !== 0 || sentences.length === 0) sentences.push(str);
      state = -1;
    }
  }
  return sentences;
}

function isSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 32 || (code >= 9 && code <= 13) || code === 0x85 || code === 0xa0) continue;
    if (code < 128) return false;
    if (!/[\s]/u.test(value[i])) return false;
  }
  return true;
}

function parseDoctype(raw: string): string {
  const inner = raw.replace(/^<!doctype\s*/i, "").replace(/>\s*$/, "").trim();
  const name = (inner.match(/^[^\s]+/)?.[0] ?? "html").toLowerCase();
  const publicId = /\bPUBLIC\s+(["'])([\s\S]*?)\1/i.exec(inner)?.[2];
  const systemId = publicId ? /\bPUBLIC\s+(["'])[\s\S]*?\1\s+(["'])([\s\S]*?)\2/i.exec(inner)?.[3] : /\bSYSTEM\s+(["'])([\s\S]*?)\1/i.exec(inner)?.[2];
  if (publicId) return `<!DOCTYPE ${name} PUBLIC "${publicId}"${systemId ? ` "${systemId}"` : ""}>`;
  if (systemId) return `<!DOCTYPE ${name} SYSTEM "${systemId}">`;
  return `<!DOCTYPE ${name}>`;
}

function mimeFormat(type: string, params: Map<string, string>): string {
  const parts = [type.toLowerCase()];
  for (const key of [...params.keys()].sort()) {
    const value = params.get(key)!;
    parts.push(`${key.toLowerCase()}=${/^[\w!#$%&'*+.^`|~-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`}`);
  }
  return parts.join("; ");
}
function adjustMeta(attrs: Attr[]) {
  const charset = attrs.find(attr => attr.name === "charset");
  if (charset && charset.value.toUpperCase() !== "UTF-8") charset.value = "UTF-8";
  const httpEquiv = attrs.find(attr => attr.name === "http-equiv");
  if (!httpEquiv || httpEquiv.value.toLowerCase() !== "content-type") return;
  const content = attrs.find(attr => attr.name === "content");
  if (!content) return;
  const pieces = content.value.split(";"), type = pieces.shift()!.trim();
  if (!type) return;
  const params = new Map<string, string>();
  for (const piece of pieces) {
    const equal = piece.indexOf("=");
    if (equal < 0) continue;
    const key = piece.slice(0, equal).trim(), raw = piece.slice(equal + 1).trim();
    params.set(key.toLowerCase(), raw.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1"));
  }
  const actual = params.get("charset");
  if (!actual || actual.toLowerCase() === "utf-8") return;
  params.set("charset", "utf-8");
  content.value = mimeFormat(type, params);
}

interface OpenElement { name: string; ns: Namespace; skip: boolean; synthetic: boolean; buffer?: { markup: string[]; hasContent: boolean } }
type Phase = "beforeHtml" | "beforeHead" | "inHead" | "afterHead" | "inBody" | "afterBody";

export function transformKepubContent(source: string): KepubContentResult {
  const lower = source.toLowerCase();
  const bodyStart = lower.indexOf("<body"), bodyEnd = lower.indexOf("</body>");
  const bodySource = bodyStart >= 0 ? source.slice(bodyStart, bodyEnd > bodyStart ? bodyEnd : undefined) : source;
  const sawKoboSpans = /class\s*=\s*(?:"[^"]*\bkoboSpan\b[^"]*"|'[^']*\bkoboSpan\b[^']*')/.test(bodySource);
  const hasColumns = /id\s*=\s*(?:"book-columns"|'book-columns')/.test(bodySource);
  const hasInner = /id\s*=\s*(?:"book-inner"|'book-inner')/.test(bodySource);
  const hasKoboDivs = hasColumns && hasInner;
  const tokenizer = new Tokenizer(source);
  const output: string[] = [];
  const stack: OpenElement[] = [];
  let phase: Phase = "beforeHtml";
  let htmlEmitted = false, headEmitted = false, headClosed = false, bodyEmitted = false, wrappers = false;
  let para = 0, seg = 0, incParaNext = false;
  const write = (text: string) => {
    if (text) output.push(text);
  };
  const top = () => stack.length ? stack[stack.length - 1] : null;
  const skipNow = () => Boolean(top()?.skip);
  const emitOpen = (name: string, attrs: Attr[], ns: Namespace, selfClosing: boolean, synthetic = false, foreignRoot = false) => {
    let normalized = attrs;
    if (ns === "html" && name === "meta") { normalized = attrs.map(attr => ({ ...attr })); adjustMeta(normalized); }
    if (ns === "html" && (name === "script" || name === "style") && !normalized.some(attr => attr.name === "type")) {
      normalized = [...normalized, { name: "type", value: name === "script" ? "text/javascript" : "text/css" }];
    }
    if (ns === "svg") {
      normalized = attrs.map(attr => ({ ...attr, name: svgAttrs[attr.name] ?? foreignAttrs[attr.name] ?? attr.name }));
      if (foreignRoot && !normalized.some(attr => attr.name === "xmlns")) normalized.push({ name: "xmlns", value: "http://www.w3.org/2000/svg" });
      if (foreignRoot && !normalized.some(attr => attr.name === "xmlns:xlink")) normalized.push({ name: "xmlns:xlink", value: "http://www.w3.org/1999/xlink" });
    } else if (ns === "math") {
      normalized = attrs.map(attr => ({ ...attr, name: mathAttrs[attr.name] ?? foreignAttrs[attr.name] ?? attr.name }));
      if (foreignRoot && !normalized.some(attr => attr.name === "xmlns")) normalized.push({ name: "xmlns", value: "http://www.w3.org/1998/Math/MathML" });
    } else if (name === "html" && !normalized.some(attr => attr.name === "xmlns")) {
      normalized = [{ name: "xmlns", value: "http://www.w3.org/1999/xhtml" }, ...normalized];
    }
    const attrText = normalized.map(attr => ` ${attr.name}="${escapeAttr(attr.value)}"`).join("");
    if (voidElements.has(name) && ns === "html") write(`<${name}${attrText}/>`);
    else if (selfClosing) write(`<${name}${attrText}></${name}>`);
    else write(`<${name}${attrText}>`);
    return { name: ns === "svg" ? (svgTags[name] ?? name) : name, ns, synthetic };
  };
  const pushElement = (name: string, ns: Namespace, selfClosing: boolean, attrs: Attr[], synthetic = false) => {
    const parentBefore = top();
    const emitted = emitOpen(name, attrs, ns, selfClosing, synthetic, ns !== "html" && parentBefore?.ns !== ns);
    if (voidElements.has(emitted.name) && ns === "html") return;
    const parent = top();
    const skip = Boolean(parent?.skip || skipSpanElements.has(emitted.name));
    if (selfClosing) return;
    stack.push({ ...emitted, skip });
  };
  const closeTop = () => {
    const element = stack.pop();
    if (element) write(`</${element.name}>`);
  };
  const closeTo = (index: number) => { while (stack.length > index) closeTop(); };
  const findOpen = (name: string, stops: Set<string> = new Set()) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === name) return i;
      if (stops.has(stack[i].name)) return -1;
    }
    return -1;
  };
  const closeParagraph = () => {
    const index = findOpen("p", pScopeStops);
    if (index >= 0) closeTo(index);
  };
  const nsFor = (name: string, parent: OpenElement | null): Namespace => {
    if (!parent) return name === "svg" ? "svg" : name === "math" ? "math" : "html";
    if (parent.ns === "svg") return ["foreignObject", "desc", "title"].includes(parent.name) ? "html" : "svg";
    if (parent.ns === "math") return parent.name === "annotation-xml" ? "html" : "math";
    return name === "svg" ? "svg" : name === "math" ? "math" : "html";
  };
  const ensureHead = () => {
    if (!htmlEmitted) { write("<html xmlns=\"http://www.w3.org/1999/xhtml\">"); htmlEmitted = true; }
    if (!headEmitted) { write("<head>"); headEmitted = true; }
  };
  const closeHead = () => {
    ensureHead();
    if (!headClosed) {
      const index = stack.findIndex(item => item.name === "head");
      if (index >= 0) closeTo(index + 1);
      write(`<style type="text/css" class="kobostylehacks">div#book-inner { margin-top: 0; margin-bottom: 0;}</style>`);
      write("</head>"); headClosed = true;
      if (index >= 0) stack.splice(index, 1);
    }
    phase = "afterHead";
  };
  const startBody = (attrs: Attr[] = []) => {
    ensureHead(); closeHead();
    if (!bodyEmitted) {
      write(`<body${attrs.map(attr => ` ${attr.name}="${escapeAttr(attr.value)}"`).join("")}>`);
      bodyEmitted = true; phase = "inBody";
      stack.push({ name: "body", ns: "html", skip: false, synthetic: false });
      if (!hasKoboDivs) { write(`<div id="book-columns"><div id="book-inner">`); wrappers = true; }
    }
  };
  const autoCloseBeforeStart = (name: string) => {
    if (blockClosesParagraph.has(name)) closeParagraph();
    if (name === "li") {
      const index = findOpen("li", new Set(["ol", "ul", "html", "body"]));
      if (index >= 0) closeTo(index);
    } else if (name === "dt" || name === "dd") {
      let other = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (["dt", "dd"].includes(stack[i].name)) { other = i; break; }
        if (["dl", "html", "body"].includes(stack[i].name)) break;
      }
      if (other >= 0) closeTo(other);
    } else if (/^h[1-6]$/.test(name)) {
      let index = -1;
      for (let i = stack.length - 1; i >= 0; i--) { if (/^h[1-6]$/.test(stack[i].name)) { index = i; break; } if (stack[i].name === "body") break; }
      if (index >= 0) closeTo(index);
    } else if (name === "option") {
      const index = findOpen("option", new Set(["select", "datalist", "html", "body"]));
      if (index >= 0) closeTo(index);
    } else if (name === "optgroup") {
      for (const tag of ["option", "optgroup"]) { const index = findOpen(tag, new Set(["select", "html", "body"])); if (index >= 0) { closeTo(index); break; } }
    } else if (name === "tr") {
      for (const tag of ["td", "th", "tr"]) { const index = findOpen(tag, new Set(["table", "tbody", "thead", "tfoot", "html", "body"])); if (index >= 0) { closeTo(index); break; } }
    } else if (name === "td" || name === "th") {
      const index = findOpen(name === "td" ? "th" : "td", new Set(["tr", "table", "html", "body"]));
      if (index >= 0) closeTo(index);
      const same = findOpen(name, new Set(["tr", "table", "html", "body"]));
      if (same >= 0) closeTo(same);
    } else if (name === "thead" || name === "tbody" || name === "tfoot") {
      for (const tag of ["td", "th", "tr", "thead", "tbody", "tfoot"]) { const index = findOpen(tag, new Set(["table", "html", "body"])); if (index >= 0) { closeTo(index); break; } }
    } else if (name === "a") {
      const index = findOpen("a", new Set(["body", "html"]));
      if (index >= 0) closeTo(index);
    } else if (name === "button") {
      const index = findOpen("button", new Set(["body", "html"]));
      if (index >= 0) closeTo(index);
    }
  };
  const tableContextStart = (name: string): boolean => {
    const parent = top();
    if (!parent || parent.ns !== "html") return false;
    if (parent.name === "table" && ["tr", "td", "th", "caption", "col", "colgroup"].includes(name)) {
      if (name === "tr") { pushElement("tbody", "html", false, [], true); return true; }
      if (name === "td" || name === "th") { pushElement("tbody", "html", false, [], true); pushElement("tr", "html", false, [], true); return true; }
    }
    if (["tbody", "thead", "tfoot"].includes(parent.name) && (name === "td" || name === "th")) { pushElement("tr", "html", false, [], true); return true; }
    return false;
  };
  const transformText = (data: string, raw: boolean) => {
    const parent = top();
    if (raw || (parent && ["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"].includes(parent.name) && parent.ns === "html")) { write(data); return; }
    const clean = data.includes("\uFFFD") ? data.replace(/\uFFFD/g, "") : data;
    if (!clean) return;
    if (!sawKoboSpans && !skipNow() && parent && (phase === "inBody" || phase === "afterBody") && bodyEmitted) {
      const sentences = splitKepubSentences(clean);
      for (const sentence of sentences) {
        if (isSpace(sentence) && parent.name !== "p") { write(escapeText(sentence)); continue; }
        if (incParaNext) { para++; seg = 0; incParaNext = false; }
        seg++;
        write(`<span class="koboSpan" id="kobo.${para}.${seg}">${escapeText(sentence)}</span>`);
      }
      return;
    }
    write(escapeText(clean));
  };
  const handleStart = (token: Extract<Token, { type: "start" }>) => {
    if (phase === "beforeHtml") {
      if (token.name === "html") {
        emitOpen(token.name, token.attrs, "html", false); htmlEmitted = true; phase = "beforeHead";
        stack.push({ name: "html", ns: "html", skip: false, synthetic: false });
        return;
      }
      write(`<html xmlns="http://www.w3.org/1999/xhtml">`); htmlEmitted = true; stack.push({ name: "html", ns: "html", skip: false, synthetic: false }); phase = "beforeHead";
    }
    if (phase === "beforeHead") {
      if (token.name === "head") {
        write(`<head${token.attrs.map(attr => ` ${attr.name}="${escapeAttr(attr.value)}"`).join("")}>`); headEmitted = true; phase = "inHead";
        if (token.selfClosing) { closeHead(); } else stack.push({ name: "head", ns: "html", skip: false, synthetic: false });
        return;
      }
      if (token.name === "html") return;
      ensureHead(); closeHead();
    }
    if (phase === "inHead") {
      if (token.name === "head") return;
      if (token.name === "body" || token.name === "html" || token.name === "frameset") { closeHead(); handleStart(token); return; }
      const allowed = new Set(["base", "basefont", "bgsound", "link", "meta", "title", "style", "script", "noscript", "template", "command"]);
      if (!allowed.has(token.name)) { closeHead(); handleStart(token); return; }
      pushElement(token.name, "html", token.selfClosing, token.attrs);
      return;
    }
    if (phase === "afterHead") {
      if (token.name === "body") { startBody(token.attrs); return; }
      if (token.name === "head" || token.name === "html") return;
      startBody();
    }
    if (phase === "afterBody" && token.name !== "html") phase = "inBody";
    if (token.name === "html") return;
    if (token.name === "body") { if (!bodyEmitted) startBody(token.attrs); return; }
    if (token.name === "head") return;
    const parent = top();
    const ns = nsFor(token.name, parent);
    if (ns === "html") {
      tableContextStart(token.name);
      autoCloseBeforeStart(token.name);
    }
    const adjustedName = ns === "svg" ? (svgTags[token.name] ?? token.name) : token.name;
    if (ns === "html" && adjustedName === "img" && !skipNow() && !sawKoboSpans) {
      para++; seg = 0; incParaNext = false; seg++;
      write(`<span class="koboSpan" id="kobo.${para}.${seg}">`);
      pushElement(adjustedName, ns, token.selfClosing, token.attrs);
      write("</span>");
      return;
    }
    pushElement(adjustedName, ns, token.selfClosing, token.attrs);
    if (ns === "html" && paragraphElements.has(adjustedName) && !skipNow()) incParaNext = true;
  };
  const handleEnd = (name: string) => {
    if (phase === "inHead" && name === "head") { closeHead(); clearToBody(); return; }
    if (name === "head") return;
    if (name === "body" || name === "html") {
      const bodyIndex = stack.findIndex(item => item.name === "body");
      if (bodyIndex >= 0) closeTo(bodyIndex + 1);
      phase = "afterBody";
      return;
    }
    if (phase === "beforeHtml" || phase === "beforeHead" || phase === "afterHead") return;
    if (phase === "afterBody") phase = "inBody";
    const bodyIndex = stack.findIndex(item => item.name === "body");
    let found = -1;
    for (let i = stack.length - 1; i > bodyIndex; i--) if (stack[i].name.toLowerCase() === name || stack[i].name === name) { found = i; break; }
    if (found >= 0) { closeTo(found); return; }
    if (name === "p") { write("<p></p>"); if (!sawKoboSpans) incParaNext = true; return; }
    if (name === "br") { write("<br/>"); return; }
  };
  const clearToBody = () => {
    const bodyIndex = stack.findIndex(item => item.name === "body");
    if (bodyIndex >= 0) closeTo(bodyIndex + 1);
  };
  for (;;) {
    const token = tokenizer.next();
    if (!token) break;
    switch (token.type) {
      case "xml":
        if (phase === "beforeHtml") write(token.raw);
        else if ((phase as Phase) === "inHead") write(`<!--?xml?-->`);
        break;
      case "doctype":
        if (phase === "beforeHtml") write(parseDoctype(token.raw));
        break;
      case "comment":
        write(`<!--${escapeComment(token.data)}-->`);
        break;
      case "text":
        if (phase === "beforeHtml") {
          if (!token.data.trim()) break;
          write(`<html xmlns="http://www.w3.org/1999/xhtml">`); htmlEmitted = true; stack.push({ name: "html", ns: "html", skip: false, synthetic: false }); phase = "beforeHead";
        }
        if (phase === "beforeHead") {
          if (!token.data.trim()) break;
          ensureHead(); closeHead();
        }
        if ((phase as Phase) === "inHead") {
          if (top()?.name !== "head") { transformText(token.data, token.raw); break; }
          if (!token.data.trim()) { write(token.data); break; }
          closeHead();
        }
        if ((phase as Phase) === "afterHead") {
          if (!token.data.trim()) { write(token.data); break; }
          startBody();
        }
        if ((phase as Phase) === "afterBody") phase = "inBody";
        transformText(token.data, token.raw);
        break;
      case "start":
        handleStart(token);
        break;
      case "end":
        handleEnd(token.name);
        break;
    }
  }
  if (!htmlEmitted) { write(`<html xmlns="http://www.w3.org/1999/xhtml">`); htmlEmitted = true; }
  if (!bodyEmitted) { ensureHead(); closeHead(); startBody(); }
  clearToBody();
  if (wrappers) write("</div></div>");
  write("</body></html>");
  return { html: output.join(""), sawKoboSpans };
}

/** Dummy-titlepage heuristic (no output, used on the first spine document). */
export function kepubTitlepageHasContent(source: string): boolean {
  const tokenizer = new Tokenizer(source);
  let paragraphs = 0, words = 0, images = 0, inBody = false;
  const skipped: string[] = [];
  const utf8Length = (word: string) => {
    let length = 0;
    for (const char of word) { const code = char.codePointAt(0)!; length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; }
    return length;
  };
  for (;;) {
    const token = tokenizer.next();
    if (!token) break;
    if (token.type === "start") {
      if (token.name === "body") { inBody = true; continue; }
      if (!inBody) continue;
      if (skipped.length) { if (!token.selfClosing && !voidElements.has(token.name)) skipped.push(token.name); continue; }
      if (token.name === "p") { paragraphs++; if (paragraphs > 4) return true; if (!token.selfClosing) skipped.push(token.name); continue; }
      if (token.name === "img") { images++; continue; }
      if (token.name === "svg") { images++; if (!token.selfClosing) skipped.push(token.name); continue; }
      if (["script", "style", "pre", "audio", "video", "math"].includes(token.name)) { if (!token.selfClosing) skipped.push(token.name); }
    } else if (token.type === "end") {
      if (token.name === "body") inBody = false;
      if (skipped.length && skipped[skipped.length - 1].toLowerCase() === token.name) skipped.pop();
    } else if (token.type === "text" && inBody && !skipped.length) {
      for (const word of token.data.split(/\s+/)) if (utf8Length(word) > 3) words++;
      if (words > 20) return true;
    }
  }
  return (images === 0 && words < 5) || images > 4;
}
