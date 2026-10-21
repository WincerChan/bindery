/**
 * Small non-validating XML reader used by the KEPUB package transform.
 *
 * OPF/container documents are tiny compared with the book text, so a tree is
 * kept here. The body converter in `kepub-html.ts` is deliberately streaming.
 */
import { dirname, joinpath } from "./archive";

export interface XmlAttribute { name: string; value: string }
export interface XmlText { type: "text"; data: string }
export interface XmlComment { type: "comment"; data: string }
export interface XmlPI { type: "pi"; target: string; data: string }
export interface XmlDoctype { type: "doctype"; raw: string }
export interface XmlElement { type: "element"; name: string; attrs: XmlAttribute[]; children: XmlNode[] }
export type XmlNode = XmlElement | XmlText | XmlComment | XmlPI | XmlDoctype;

export interface XmlDocument {
  declaration: string | null;
  prolog: XmlNode[];
  root: XmlElement | null;
}

const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
export const localName = (name: string) => name.slice(name.indexOf(":") + 1);
export const xmlAttribute = (node: XmlElement, name: string) => {
  const found = node.attrs.find(attr => attr.name === name) ?? node.attrs.find(attr => localName(attr.name) === name);
  return found?.value;
};
export const xmlChildren = (node: XmlElement, name?: string) =>
  node.children.filter((child): child is XmlElement => child.type === "element" && (!name || localName(child.name) === name));
export function xmlDescendants(node: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of node.children) if (child.type === "element") {
    if (!name || localName(child.name) === name) out.push(child);
    out.push(...xmlDescendants(child, name));
  }
  return out;
}
function decodeXmlText(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole: string, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return whole; }
  });
}
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");

/** Lenient enough for real OPF files, but strict about leaving the input position consistent. */
export function parseXmlDocument(source: string): XmlDocument {
  let text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let at = 0;
  const declaration = /^<\?xml\b[\s\S]*?\?>/.exec(text)?.[0] ?? null;
  if (declaration) at = declaration.length;
  const prolog: XmlNode[] = [];
  const document: XmlDocument = { declaration, prolog, root: null };

  const readUntil = (needle: string) => {
    const end = text.indexOf(needle, at);
    if (end < 0) { const value = text.slice(at); at = text.length; return value; }
    const value = text.slice(at, end); at = end + needle.length; return value;
  };
  const skipMisc = () => {
    while (at < text.length) {
      if (isSpace(text.charCodeAt(at))) { at++; continue; }
      if (text.startsWith("<!--", at)) {
        at += 4;
        const data = readUntil("-->");
        prolog.push({ type: "comment", data });
        continue;
      }
      if (text.startsWith("<?", at)) {
        at += 2;
        const inner = readUntil("?>");
        const space = inner.search(/\s/);
        if (space < 0) prolog.push({ type: "pi", target: inner, data: "" });
        else prolog.push({ type: "pi", target: inner.slice(0, space), data: inner.slice(space).trim() });
        continue;
      }
      if (/^<!DOCTYPE\b/i.test(text.slice(at, at + 10))) {
        const start = at;
        let quote = "";
        while (at < text.length) {
          const ch = text[at++];
          if (quote) { if (ch === quote) quote = ""; continue; }
          if (ch === '"' || ch === "'") { quote = ch; continue; }
          if (ch === ">") break;
        }
        prolog.push({ type: "doctype", raw: text.slice(start, at) });
        continue;
      }
      break;
    }
  };

  const parseElement = (): XmlElement => {
    if (text[at] !== "<") throw new Error("XML：预期元素");
    at++;
    const nameStart = at;
    while (at < text.length && !isSpace(text.charCodeAt(at)) && !"/>".includes(text[at])) at++;
    const name = text.slice(nameStart, at), attrs: XmlAttribute[] = [];
    for (;;) {
      while (at < text.length && isSpace(text.charCodeAt(at))) at++;
      if (at >= text.length) throw new Error("XML：元素未结束");
      if (text.startsWith("/>", at)) { at += 2; return { type: "element", name, attrs, children: [] }; }
      if (text[at] === ">") { at++; break; }
      const attrStart = at;
      while (at < text.length && !isSpace(text.charCodeAt(at)) && !"=".includes(text[at]) && !"/>".includes(text[at])) at++;
      const attrName = text.slice(attrStart, at);
      if (!attrName) throw new Error("XML：无效属性");
      while (at < text.length && isSpace(text.charCodeAt(at))) at++;
      let value = "";
      if (text[at] === "=") {
        at++;
        while (at < text.length && isSpace(text.charCodeAt(at))) at++;
        const quote = text[at];
        if (quote === '"' || quote === "'") {
          at++;
          const end = text.indexOf(quote, at);
          if (end < 0) throw new Error("XML：属性未结束");
          value = text.slice(at, end); at = end + 1;
        } else {
          const valueStart = at;
          while (at < text.length && !isSpace(text.charCodeAt(at)) && !"/>".includes(text[at])) at++;
          value = text.slice(valueStart, at);
        }
      }
      if (!attrs.some(attr => attr.name === attrName)) attrs.push({ name: attrName, value: decodeXmlText(value) });
    }
    const children: XmlNode[] = [];
    for (;;) {
      if (at >= text.length) throw new Error(`XML：缺少结束标签（${name}）`);
      if (text.startsWith("</", at)) {
        at += 2;
        const endStart = at;
        while (at < text.length && !">".includes(text[at])) at++;
        const endName = text.slice(endStart, at).trim(); at++;
        if (endName !== name) throw new Error(`XML：结束标签 ${endName} 与 ${name} 不匹配`);
        return { type: "element", name, attrs, children };
      }
      if (text.startsWith("<!--", at)) {
        at += 4; children.push({ type: "comment", data: readUntil("-->") }); continue;
      }
      if (text.startsWith("<![CDATA[", at)) {
        at += 9; children.push({ type: "text", data: readUntil("]]>") }); continue;
      }
      if (text.startsWith("<?", at)) {
        at += 2;
        const inner = readUntil("?>"), space = inner.search(/\s/);
        children.push(space < 0 ? { type: "pi", target: inner, data: "" } : { type: "pi", target: inner.slice(0, space), data: inner.slice(space).trim() });
        continue;
      }
      if (text[at] === "<") { children.push(parseElement()); continue; }
      const end = text.indexOf("<", at), value = text.slice(at, end < 0 ? text.length : end);
      at = end < 0 ? text.length : end;
      children.push({ type: "text", data: decodeXmlText(value) });
    }
  };

  skipMisc();
  if (at < text.length && text[at] === "<") document.root = parseElement();
  return document;
}

function inlineChildren(children: XmlNode[]): string {
  return children.map(node => {
    if (node.type === "text") return escapeText(node.data);
    if (node.type === "comment") return `<!--${node.data}-->`;
    if (node.type === "pi") return `<?${node.target}${node.data ? " " + node.data : ""}?>`;
    if (node.type === "doctype") return node.raw;
    return "";
  }).join("");
}

function renderElement(node: XmlElement, depth: number, spaces: number): string {
  const attrs = node.attrs.map(attr => ` ${attr.name}="${escapeAttribute(attr.value)}"`).join("");
  const elements = node.children.some(child => child.type !== "text" && child.type !== "comment" && child.type !== "pi");
  const nonSpaceText = node.children.some(child => child.type === "text" && child.data.trim() !== "");
  if (!node.children.length) return `<${node.name}${attrs}/>`;
  if (nonSpaceText || !elements) return `<${node.name}${attrs}>${inlineChildren(node.children).replace(/\s+/g, (value) => value)}</${node.name}>`;
  const pad = " ".repeat(depth * spaces), body: string[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      if (child.data.trim() === "") continue;
      body.push("\n" + pad + " ".repeat(spaces) + escapeText(child.data));
      continue;
    }
    if (child.type === "comment") { body.push("\n" + pad + " ".repeat(spaces) + `<!--${child.data}-->`); continue; }
    if (child.type === "pi") { body.push("\n" + pad + " ".repeat(spaces) + `<?${child.target}${child.data ? " " + child.data : ""}?>`); continue; }
    if (child.type === "doctype") { body.push("\n" + pad + " ".repeat(spaces) + child.raw); continue; }
    body.push("\n" + pad + " ".repeat(spaces) + renderElement(child, depth + 1, spaces));
  }
  return `<${node.name}${attrs}>${body.join("")}\n${pad}</${node.name}>`;
}

/** Mirrors beevik/etree's `Document.Indent(4)` / `WriteTo` output shape for package files. */
export function serializeXmlDocument(document: XmlDocument, spaces = 4): string {
  if (!document.root) return document.declaration ?? "";
  const preamble = [document.declaration, ...document.prolog.map(node => {
    if (node.type === "comment") return `<!--${node.data}-->`;
    if (node.type === "pi") return `<?${node.target}${node.data ? " " + node.data : ""}?>`;
    if (node.type === "doctype") return node.raw;
    return "";
  }).filter(Boolean)];
  return `${preamble.length ? preamble.join("\n") + "\n" : ""}${renderElement(document.root, 0, spaces)}\n`;
}

export interface OpfPackage {
  opfPath: string;
  document: XmlDocument;
  root: XmlElement;
  contentDocuments: { path: string; href: string }[];
  firstSpineDocument: { path: string; href: string } | null;
}

/** Container/OPF discovery used by the converter and by tests. */
export function readOpfPackage(containerXml: string, opfPath: string, opfXml: string): OpfPackage {
  const document = parseXmlDocument(opfXml);
  if (!document.root) throw new Error("EPUB 的 OPF 缺少 package 元素");
  const root = document.root;
  const manifest = xmlChildren(root, "manifest")[0];
  const spine = xmlChildren(root, "spine")[0];
  const items = manifest ? xmlChildren(manifest, "item") : [];
  const contentDocuments = items.flatMap(item => {
    const href = xmlAttribute(item, "href") ?? "";
    if (!href) return [];
    const media = (xmlAttribute(item, "media-type") ?? "").toLowerCase();
    const ext = (href.split(/[?#]/, 1)[0].match(/\.[^./\\]*$/)?.[0] ?? "").toLowerCase();
    return media === "application/xhtml+xml" || media === "text/html" || [".htm", ".html", ".xhtml"].includes(ext)
      ? [{ path: joinpath(dirname(opfPath), href), href }]
      : [];
  });
  let firstSpineDocument: OpfPackage["firstSpineDocument"] = null;
  if (spine) {
    const first = xmlChildren(spine, "itemref").find(ref => xmlAttribute(ref, "linear") !== "no");
    const idref = first ? xmlAttribute(first, "idref") : undefined;
    const item = idref ? items.find(candidate => xmlAttribute(candidate, "id") === idref) : undefined;
    const href = item ? xmlAttribute(item, "href") ?? "" : "";
    const ext = (href.match(/\.[^./\\]*$/)?.[0] ?? "").toLowerCase();
    if (href && [".htm", ".html", ".xhtml"].includes(ext)) firstSpineDocument = { path: joinpath(dirname(opfPath), href), href };
  }
  return { opfPath, document, root, contentDocuments, firstSpineDocument };
}
