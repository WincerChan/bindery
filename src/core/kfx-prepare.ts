import { XMLSerializer } from "@xmldom/xmldom";
import { writeArchive, type ArchiveMember } from "./archive";
import { EpubArchive } from "./epub";
import { attr, descendants, parseXml, type Element } from "./xml";

const XHTML_NS = "http://www.w3.org/1999/xhtml", XLINK_NS = "http://www.w3.org/1999/xlink";
// Anything else drawn by the SVG means it is more than a wrapped picture.
const DRAWN = new Set(["path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "use", "text", "foreignObject", "image"]);

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
  return changed ? new XMLSerializer().serializeToString(root.ownerDocument!) : null;
}

/**
 * boko renders inline `<svg>` as empty containers, so an SVG-wrapped cover page (the usual Calibre/Sigil
 * `titlepage.xhtml`) becomes a page with no content, and a Kindle Oasis 3 on firmware 5.18.1 hangs opening the
 * book until it restarts. An SVG that only shows one raster image is rewritten to an equivalent `<img>`; other
 * SVG is left alone. Returns the input unchanged when nothing needs rewriting, so boko sees identical bytes.
 */
export function prepareEpubForBoko(data: Uint8Array): Uint8Array {
  const archive = new EpubArchive(data), decoder = new TextDecoder(), encoder = new TextEncoder();
  let changed = false;
  const entries: ArchiveMember[] = archive.entries.map(entry => {
    if (!/\.(?:xhtml|html?)$/i.test(entry.name)) return entry;
    const text = decoder.decode(entry.data);
    if (!/<svg\b/i.test(text) || !/<image\b/i.test(text)) return entry;
    const rewritten = rewriteDocument(text);
    if (rewritten === null) return entry;
    changed = true;
    return { name: entry.name, data: encoder.encode(rewritten) };
  });
  return changed ? writeArchive(entries) : data;
}
