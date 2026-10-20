import { vi } from "vitest";
import { clientDocument } from "./client-dom";

/** Synthetic geometry only: the XML DOM has no CSS cascade, columns, fonts or Range layout. */
export function previewDocumentFixture(path = "/book/a/epub/Text/%E7%AC%AC%E4%B8%80%20%E7%AB%A0.xhtml") {
  const document = clientDocument(), root = document.documentElement;
  const head = document.createElement("head"), body = document.createElement("body");
  root.appendChild(head); root.appendChild(body);
  const style = () => {
    const values = new Map<string, { value: string; priority: string }>();
    return {
      get cssText() { return [...values].map(([name, { value, priority }]) => `${name}: ${value}${priority ? " !important" : ""}`).join(";"); },
      set cssText(css: string) {
        values.clear();
        for (const declaration of css.split(";")) {
          const split = declaration.indexOf(":"); if (split < 0) continue;
          const name = declaration.slice(0, split).trim(), value = declaration.slice(split + 1).trim();
          values.set(name, { value: value.replace(/\s*!important$/, ""), priority: value.endsWith("!important") ? "important" : "" });
        }
      },
      setProperty: (name: string, value: string, priority = "") => { values.set(name, { value, priority }); },
      getPropertyValue: (name: string) => values.get(name)?.value ?? "", getPropertyPriority: (name: string) => values.get(name)?.priority ?? "",
      removeProperty: (name: string) => { values.delete(name); } };
  };
  for (const element of [root, body]) Object.defineProperty(element, "style", { value: style(), configurable: true });
  const fonts = Object.assign(new Set<FontFace>(), { ready: Promise.resolve(), addEventListener: vi.fn<(type: string, listener: () => void) => void>(), removeEventListener: vi.fn() });
  const listeners = new Map<string, Set<EventListener>>();
  Object.assign(head, { append: (...nodes: Node[]) => nodes.forEach(node => head.appendChild(node)) });
  Object.assign(document, {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => { listeners.get(type)?.delete(listener); }),
    getSelection: () => ({ isCollapsed: true }),
  });
  let extent = 3 * 1072 - 80, left = 0;
  Object.defineProperties(root, {
    scrollWidth: { configurable: true, get: () => Math.max(extent, Number.parseFloat(root.style.getPropertyValue("--bindery-page-end") || "0") + 1) },
    scrollLeft: { configurable: true, get: () => left, set: (value: number) => { left = Math.max(0, Math.min(value, root.scrollWidth - Number.parseFloat(root.style.getPropertyValue("width") || "1072"))); } },
    scrollTop: { value: 0, writable: true },
  });
  Object.defineProperties(document, { head: { value: head }, body: { value: body }, fonts: { value: fonts }, scrollingElement: { value: root },
    readyState: { value: "complete" }, contentType: { value: "text/html" }, URL: { value: `http://bindery.local${path}`, configurable: true } });
  const dispatch = (type: string, extra: object = {}) => {
    const event = { target: body, currentTarget: document, button: 0, clientX: 536, preventDefault: vi.fn(), ...extra };
    for (const listener of listeners.get(type) ?? []) listener(event as unknown as Event);
    return event;
  };
  return { document, root, head, body, fonts, dispatch, setExtent: (value: number) => { extent = value; } };
}
