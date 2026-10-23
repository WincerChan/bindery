import { XMLSerializer } from "@xmldom/xmldom";
import { writeArchive, type ArchiveMember } from "./archive";
import { EpubArchive } from "./epub";
import { attr, descendants, parseXml, type Element, type Node } from "./xml";

const XHTML_NS = "http://www.w3.org/1999/xhtml", XLINK_NS = "http://www.w3.org/1999/xlink";
// Anything else drawn by the SVG means it is more than a wrapped picture.
const DRAWN = new Set(["path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "use", "text", "foreignObject", "image"]);

/**
 * HTML block-level elements whose line boxes start/end with collapsed whitespace. `pre` is listed
 * because it is a block boundary for its parent, but is itself skipped as preformatted.
 */
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "dialog", "dir", "div",
  "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hgroup", "hr", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul",
]);
const PREFORMATTED_ELEMENTS = new Set(["pre", "textarea", "listing", "xmp", "plaintext"]);
// Inline replaced/atomic content: a line box does not trim through its own contents.
const ATOMIC_ELEMENTS = new Set(["img", "svg", "math", "video", "audio", "canvas", "iframe", "object", "embed", "input", "select", "textarea", "button", "meter", "progress"]);
const COLLAPSIBLE_START = /^[ \t\n\r\f]+/, COLLAPSIBLE_END = /[ \t\n\r\f]+$/, COLLAPSIBLE_RUN = /[ \t\n\r\f]+/g;
const WHITE_SPACE_PRE = /(?:^|;)\s*white-space\s*:\s*pre\b/i;

function isPreformatted(element: Element): boolean {
  return PREFORMATTED_ELEMENTS.has((element.localName ?? "").toLowerCase()) || WHITE_SPACE_PRE.test(attr(element, "style"));
}

function insidePreformatted(node: Node): boolean {
  for (let current: Node | null = node; current && current.nodeType === 1; current = current.parentNode) {
    if (isPreformatted(current as Element)) return true;
  }
  return false;
}

type InlineItem = { text: Node } | { content: Node };
/** Inline runs between line/block boundaries. Each run is one browser line box for whitespace purposes. */
function lineSegments(block: Element): InlineItem[][] {
  const segments: InlineItem[][] = [[]];
  const walk = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        segments.at(-1)!.push({ text: child });
        continue;
      }
      if (child.nodeType !== 1) {
        // Comments and processing instructions are not rendered; other node types are atomic.
        if (child.nodeType !== 7 && child.nodeType !== 8 && child.nodeValue?.trim()) segments.at(-1)!.push({ content: child });
        continue;
      }
      const element = child as Element, name = (element.localName ?? "").toLowerCase();
      if (name === "br" || BLOCK_ELEMENTS.has(name)) {
        // A line break or a nested block ends this line box; the block is trimmed separately.
        segments.push([]);
        continue;
      }
      if (isPreformatted(element) || ATOMIC_ELEMENTS.has(name)) {
        segments.at(-1)!.push({ content: element });
        continue;
      }
      walk(element);
    }
  };
  walk(block);
  return segments;
}

/** Removes the collapsible whitespace at both ends of every line box in one block. */
function trimBlock(block: Element): boolean {
  if (insidePreformatted(block)) return false;
  let changed = false;
  for (const segment of lineSegments(block)) {
    for (const item of segment) {
      if (!("text" in item)) break;
      const value = item.text.nodeValue ?? "", trimmed = value.replace(COLLAPSIBLE_START, "");
      if (trimmed !== value) {
        item.text.nodeValue = trimmed;
        changed = true;
      }
      if (trimmed) break;
    }
    for (let index = segment.length - 1; index >= 0; index--) {
      const item = segment[index]!;
      if (!("text" in item)) break;
      const value = item.text.nodeValue ?? "", trimmed = value.replace(COLLAPSIBLE_END, "");
      if (trimmed !== value) {
        item.text.nodeValue = trimmed;
        changed = true;
      }
      if (trimmed) break;
    }
    // boko collapses runs inside one text node but keeps the extra spaces when a run crosses an
    // inline element boundary (`A <span>  B</span>`); a browser still renders one space.
    let previousSpace = false;
    for (const item of segment) {
      if (!("text" in item)) {
        previousSpace = false;
        continue;
      }
      const value = item.text.nodeValue ?? "";
      let normalized = value.replace(COLLAPSIBLE_RUN, " ");
      if (previousSpace && normalized.startsWith(" ")) normalized = normalized.slice(1);
      if (normalized !== value) {
        item.text.nodeValue = normalized;
        changed = true;
      }
      if (normalized) previousSpace = normalized.endsWith(" ");
    }
  }
  return changed;
}

/** The single raster image an inline SVG shows, or null when it draws anything else. */
function wrappedImage(svg: Element): string | null {
  const drawn = descendants(svg).filter(node => DRAWN.has(node.localName ?? ""));
  if (drawn.length !== 1 || drawn[0].localName !== "image") return null;
  const href = drawn[0].getAttributeNS(XLINK_NS, "href") || attr(drawn[0], "href");
  return href.trim() ? href : null;
}

function rewriteDocument(text: string): string | null {
  let root: Element;
  try { root = parseXml(text); } catch { return null; }
  let changed = false;
  for (const svg of descendants(root, "svg")) {
    const href = wrappedImage(svg);
    if (!href || !svg.parentNode) continue;
    const img = root.ownerDocument!.createElementNS(XHTML_NS, "img");
    img.setAttribute("src", href); img.setAttribute("alt", ""); img.setAttribute("style", "height: 100%; max-width: 100%");
    svg.parentNode.replaceChild(img, svg);
    changed = true;
  }
  for (const block of descendants(root)) {
    if (BLOCK_ELEMENTS.has((block.localName ?? "").toLowerCase()) && trimBlock(block)) changed = true;
  }
  return changed ? new XMLSerializer().serializeToString(root.ownerDocument!) : null;
}

/**
 * boko renders inline `<svg>` as empty containers, so an SVG-wrapped cover page (the usual Calibre/Sigil
 * `titlepage.xhtml`) becomes a page with no content, and a Kindle Oasis 3 on firmware 5.18.1 hangs opening the
 * book until it restarts. An SVG that only shows one raster image is rewritten to an equivalent `<img>`; other
 * SVG is left alone.
 *
 * boko also keeps one collapsible space at the start/end of a block where a browser drops it, which turns a
 * profile text indent into "indent + space" on the device. Leading/trailing whitespace is removed per browser
 * line box (across inline elements, at `<br>` and nested-block boundaries); `pre` and `white-space: pre*` are
 * untouched. Runs inside one text node are already collapsed by boko, but runs crossing inline element boundaries
 * are not, so all collapsible runs become one space as the browser renders them.
 *
 * Returns the input unchanged when nothing needs rewriting, so boko sees identical bytes.
 */
export function prepareEpubForBoko(data: Uint8Array): Uint8Array {
  const archive = new EpubArchive(data), decoder = new TextDecoder(), encoder = new TextEncoder();
  let changed = false;
  const entries: ArchiveMember[] = archive.entries.map(entry => {
    if (!/\.(?:xhtml|html?)$/i.test(entry.name)) return entry;
    const text = decoder.decode(entry.data);
    const rewritten = rewriteDocument(text);
    if (rewritten === null) return entry;
    changed = true;
    return { name: entry.name, data: encoder.encode(rewritten) };
  });
  return changed ? writeArchive(entries) : data;
}
