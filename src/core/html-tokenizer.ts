/** Streaming HTML/XHTML tokenizer shared by KEPUB conversion and text extraction. */
import { KEPUB_ENTITIES } from "./kepub-entities";

export interface Attr { name: string; value: string }
export type Token =
  | { type: "text"; data: string; raw: boolean }
  | { type: "start"; name: string; attrs: Attr[]; selfClosing: boolean }
  | { type: "end"; name: string }
  | { type: "comment"; data: string }
  | { type: "doctype"; raw: string }
  | { type: "xml"; raw: string };

const rawElements = new Set(["iframe", "noembed", "noframes", "noscript", "plaintext", "script", "style", "textarea", "title", "xmp"]);
const rcdataElements = new Set(["title", "textarea"]);
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

export class HtmlTokenizer {
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
