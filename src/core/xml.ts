import { DOMParser } from "@xmldom/xmldom";
import type { Element, Node } from "@xmldom/xmldom";
export type { Element, Node } from "@xmldom/xmldom";
export const OPF_NS = "http://www.idpf.org/2007/opf",
  DC_NS = "http://purl.org/dc/elements/1.1/";
export function parseXml(raw: string | Uint8Array): Element {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  return new DOMParser({
    onError: (level, message) => {
      if (level === "fatalError") throw new Error(message);
    },
  }).parseFromString(text, "application/xml").documentElement!;
}
export function children(node: Node, name?: string): Element[] {
  const out: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling)
    if (
      child.nodeType === 1 &&
      (!name || (child as Element).localName === name)
    )
      out.push(child as Element);
  return out;
}
export function descendants(node: Node, name?: string): Element[] {
  return children(node).flatMap((c) => [
    ...(!name || c.localName === name ? [c] : []),
    ...descendants(c, name),
  ]);
}
export const child = (node: Node, name: string): Element | undefined =>
  children(node, name)[0];
export const attr = (node: Element, name: string): string =>
  node.getAttribute(name) ?? "";
export function removeElement(node: Element): void {
  // ElementTree removes an element's tail together with it.
  const tail = node.nextSibling;
  if (tail?.nodeType === 3) node.parentNode!.removeChild(tail);
  node.parentNode!.removeChild(node);
}
export function appendElement(
  parent: Element,
  ns: string,
  name: string,
  text?: string,
  attrs: Record<string, string> = {},
): Element {
  const doc = parent.ownerDocument!,
    node = doc.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  if (text) node.appendChild(doc.createTextNode(text));
  parent.appendChild(node);
  return node;
}
const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) =>
  escapeText(s)
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#09;");
// Match legacy ElementTree's namespace allocation, attribute order, empty tags and whitespace.
// This is serialization behavior, not parity-test normalization.
export function serializeElementTree(root: Element): Uint8Array {
  const namespaces = new Map<string, string>(),
    xml = "http://www.w3.org/XML/1998/namespace",
    xmlns = "http://www.w3.org/2000/xmlns/";
  const known: Record<string, string> = {
    [DC_NS]: "dc",
    "http://www.w3.org/1999/xhtml": "html",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf",
    "http://schemas.xmlsoap.org/wsdl/": "wsdl",
    "http://www.w3.org/2001/XMLSchema": "xs",
    "http://www.w3.org/2001/XMLSchema-instance": "xsi",
  };
  const prefix = (ns: string | null): string => {
    if (!ns) return "";
    if (ns === xml) return "xml";
    if (!namespaces.has(ns))
      namespaces.set(ns, known[ns] ?? `ns${namespaces.size}`);
    return namespaces.get(ns)!;
  };
  const nodes = [root, ...descendants(root)];
  for (const node of nodes) {
    prefix(node.namespaceURI);
    for (let i = 0; i < node.attributes.length; i++) {
      const a = node.attributes.item(i)!;
      if (a.namespaceURI !== xmlns && a.name !== "xmlns")
        prefix(a.namespaceURI);
    }
  }
  function render(node: Node, isRoot = false): string {
    if (node.nodeType === 3 || node.nodeType === 4)
      return escapeText(node.nodeValue ?? "");
    if (node.nodeType !== 1) return ""; // ET.fromstring discards comments / processing instructions.
    const el = node as Element,
      p = prefix(el.namespaceURI),
      name = p ? `${p}:${el.localName}` : el.tagName;
    let out = `<${name}`;
    if (isRoot)
      for (const [uri, pre] of [...namespaces].sort((a, b) =>
        a[1].localeCompare(b[1]),
      ))
        out += ` xmlns:${pre}="${escapeAttr(uri)}"`;
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes.item(i)!;
      if (a.namespaceURI === xmlns || a.name === "xmlns") continue;
      const ap = prefix(a.namespaceURI);
      out += ` ${ap ? ap + ":" + a.localName : a.name}="${escapeAttr(a.value)}"`;
    }
    let body = "";
    for (let c = el.firstChild; c; c = c.nextSibling) body += render(c);
    return body ? `${out}>${body}</${name}>` : `${out} />`;
  }
  return new TextEncoder().encode(
    `<?xml version='1.0' encoding='utf-8'?>\n${render(root, true)}`,
  );
}
