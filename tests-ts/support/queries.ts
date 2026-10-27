import { clientDocument, elements } from "./client-dom";

type Match = string | RegExp;
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const matches = (value: string, expected: Match) => {
  if (typeof expected === "string") return normalize(value) === normalize(expected);
  expected.lastIndex = 0;
  return expected.test(normalize(value));
};

/** Parse SSR with the same HTML parser as the hydration harness (not an XML parser). */
export function parseHtml(html: string): Element {
  const root = clientDocument().createElement("div");
  root.innerHTML = html;
  return root;
}
export const allByAttribute = (root: Element, name: string, value?: Match) => elements(root, "*", name).filter(el => value === undefined || matches(el.getAttribute(name)!, value));
function one(nodes: Element[], description: string): Element {
  if (nodes.length !== 1) throw new Error(`Expected one ${description}, found ${nodes.length}`);
  return nodes[0]!;
}
export const byAttribute = (root: Element, name: string, value?: Match) => one(allByAttribute(root, name, value), `${name}=${String(value)}`);
export const byName = (root: Element, name: string) => byAttribute(root, "name", name);

// Deliberately small subset of accessible-name/role computation used by these tests.
// Includes hidden/closed controls: SSR tests also inspect actions available after opening a panel.
function labelText(label: Element): string {
  const text = (node: Node): string => node.nodeType === 3 ? node.textContent || "" : node.nodeType === 8 ? ""
    : node.nodeType === 1 && (["input", "select", "textarea", "script", "style"].includes((node as Element).localName) || (node as Element).getAttribute("aria-hidden") === "true") ? ""
    : Array.from(node.childNodes).map(text).join("");
  return normalize(label.getAttribute("aria-label") || text(label));
}
export function accessibleName(el: Element): string {
  let top = el; while (top.parentNode?.nodeType === 1) top = top.parentNode as Element;
  const ids = el.getAttribute("aria-labelledby");
  if (ids) return normalize(ids.split(/\s+/).map(id => elements(top, "*").find(node => node.id === id)?.textContent || "").join(" "));
  if (el.hasAttribute("aria-label")) return normalize(el.getAttribute("aria-label")!);
  if (["input", "select", "textarea", "button", "output", "meter", "progress"].includes(el.localName)) {
    // Search the fragment, not documentElement: SSR fragments are detached and scoped.
    const labels = [top, ...elements(top, "label")].filter(label => label.localName === "label" &&
      ((el.id && label.getAttribute("for") === el.id) || elements(label, "*").includes(el)));
    if (labels.length) return labels.map(labelText).join(" ");
  }
  if (el.localName === "img") return el.getAttribute("alt") || "";
  if (el.localName === "fieldset") return elements(el, "legend")[0]?.textContent || "";
  return labelText(el);
}
function role(el: Element): string | null {
  if (el.hasAttribute("role")) return el.getAttribute("role");
  const tag = el.localName;
  if (tag === "a") return el.hasAttribute("href") ? "link" : null;
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") return ({ checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox", button: "button", submit: "button", reset: "button", hidden: "", file: "", password: "" } as Record<string, string>)[el.getAttribute("type") || "text"] ?? "textbox";
  return ({ button: "button", summary: "button", dialog: "dialog", nav: "navigation", main: "main", aside: "complementary", section: el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "", textarea: "textbox", select: el.hasAttribute("multiple") || Number(el.getAttribute("size")) > 1 ? "listbox" : "combobox", option: "option", img: "img", table: "table", tr: "row", th: el.getAttribute("scope") === "row" ? "rowheader" : "columnheader", td: "cell", ul: "list", ol: "list", li: "listitem", progress: "progressbar", fieldset: "group", form: "form" } as Record<string, string>)[tag] || null;
}
export const allByRole = (root: Element, expected: string, name?: Match) => elements(root, "*").filter(el => role(el) === expected && (name === undefined || matches(accessibleName(el), name)));
export const byRole = (root: Element, expected: string, name?: Match) => one(allByRole(root, expected, name), `role ${expected} (${String(name)})`);
export const byLabel = (root: Element, label: Match) => one(elements(root, "*").filter(el => ["input", "select", "textarea"].includes(el.localName) && matches(accessibleName(el), label)), `field labelled ${String(label)}`);
export const allByText = (root: Element, text: Match) => elements(root, "*").filter(el => matches(el.textContent || "", text) && !elements(el, "*").some(child => matches(child.textContent || "", text)));
export const byText = (root: Element, text: Match) => one(allByText(root, text), `text ${String(text)}`);
/** Find the form owning a control without assuming immediate DOM parentage. */
export function formFor(control: Element): Element {
  let node: Node | null = control;
  while (node?.nodeType === 1) { if ((node as Element).localName === "form") return node as Element; node = node.parentNode; }
  throw new Error("Control has no containing form");
}

