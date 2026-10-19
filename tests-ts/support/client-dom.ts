import { DOMImplementation } from "@xmldom/xmldom";
import { createRequire } from "node:module";

// Reuse the HTML parser already used by the installed Solid JSX compiler.
// No browser, sockets, or additional test dependencies are needed.
const require = createRequire(import.meta.url);
const solidPlugin = createRequire(require.resolve("vite-plugin-solid"));
const compiler = createRequire(createRequire(solidPlugin.resolve("@solidjs/vite-plugin")).resolve("@solidjs/babel-plugin"));
type HtmlNode = { nodeName: string; tagName?: string; value?: string; data?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[] };
const { parseFragment } = compiler("parse5") as { parseFragment(html: string): HtmlNode };
const listeners = new WeakMap<Element, Map<string, Set<EventListener>>>();

/** Node-tree DOM for Solid render/hydrate tests; excludes layout and event bubbling. */
export function clientDocument(): Document {
  const document = new DOMImplementation().createDocument(null, "root") as unknown as Document;
  const createElement = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const element = createElement(tag);
    // xmldom is an XML DOM; Solid's form-property dispatch uses HTML nodeName.
    Object.defineProperty(element, "nodeName", { value: tag.toUpperCase() });
    return element;
  }) as typeof document.createElement;
  const elementPrototype = Object.getPrototypeOf(document.createElement("div"));
  elementPrototype.remove = function (this: Element) { this.parentNode?.removeChild(this); };
  elementPrototype.addEventListener = function (this: Element, type: string, callback: EventListener) {
    if (!listeners.has(this)) listeners.set(this, new Map());
    const events = listeners.get(this)!;
    if (!events.has(type)) events.set(type, new Set());
    events.get(type)!.add(callback);
  };
  elementPrototype.removeEventListener = function (this: Element, type: string, callback: EventListener) {
    listeners.get(this)?.get(type)?.delete(callback);
  };
  elementPrototype.showModal = function () { this.open = true; };
  elementPrototype.close = function () { this.open = false; };
  const textPrototype = Object.getPrototypeOf(document.createTextNode(""));
  textPrototype.remove = elementPrototype.remove;
  Object.defineProperty(textPrototype, "data", { configurable: true,
    get() { return this._clientData || ""; },
    set(value) { this._clientData = String(value); },
  });
  Object.getPrototypeOf(document.createComment("")).remove = elementPrototype.remove;
  for (const prototype of [elementPrototype, textPrototype, Object.getPrototypeOf(document.createComment(""))]) {
    Object.defineProperty(prototype, "isConnected", { configurable: true, get(this: Node) {
      let node: Node | null = this;
      while (node) { if (node.nodeType === 9) return true; node = node.parentNode; }
      return false;
    } });
  }
  elementPrototype.querySelectorAll = function (this: Element, selector: string) {
    if (selector !== "*[_hk]") throw new Error(`Unsupported selector: ${selector}`);
    return elements(this, "*", "_hk");
  };
  Object.defineProperty(elementPrototype, "className", {
    configurable: true,
    get(this: Element) { return this.getAttribute("class") || ""; },
    set(this: Element, value: string) { this.setAttribute("class", value); },
  });
  for (const name of ["id", "value"]) Object.defineProperty(elementPrototype, name, {
    configurable: true,
    get(this: Element) { return this.getAttribute(name) || ""; },
    set(this: Element, value: unknown) { this.setAttribute(name, String(value)); },
  });
  function append(parent: Node, node: HtmlNode) {
    const child = node.nodeName === "#text" ? document.createTextNode(node.value || "")
      : node.nodeName === "#comment" ? document.createComment(node.data || "")
      : document.createElement(node.tagName!);
    if (child.nodeType === 1) for (const attr of node.attrs || []) (child as Element).setAttribute(attr.name, attr.value);
    for (const nested of node.childNodes || []) append(child, nested);
    parent.appendChild(child);
  }
  Object.defineProperty(elementPrototype, "innerHTML", {
    configurable: true,
    set(this: HTMLTemplateElement, html: string) {
      const target = this.localName === "template" ? document.createDocumentFragment() : this;
      target.textContent = "";
      for (const node of parseFragment(html).childNodes || []) append(target, node);
      if (target !== this) Object.defineProperty(this, "content", { value: target, configurable: true });
    },
  });
  return document;
}

export function elements(root: Element, tag: string, attribute?: string): Element[] {
  return Array.from(root.getElementsByTagName(tag)).filter(node => !attribute || node.hasAttribute(attribute));
}

// Exercise handlers without pretending to implement browser event propagation.
export function fire(node: Element, type: string) {
  const event = { target: node, currentTarget: node, preventDefault() {} } as unknown as Event;
  for (const listener of listeners.get(node)?.get(type) || []) listener.call(node, event);
  const delegated = (node as unknown as Record<string, EventListener>)[`_$$${type}`];
  delegated?.call(node, event);
}
