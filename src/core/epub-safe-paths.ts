import { archiveMemberNames, canonicalZipMember, extension, readArchive, relativeHref, writeArchive, type ArchiveMember, type ArchivePatch } from "./archive";
import { rewriteCssUrls } from "./css-strip";
import { resolveEpubReference } from "./epub-path";

// FAT/exFAT and Windows reject these; `#`, `?` and `%` also make member names ambiguous as URLs.
const unsafeSegment = /[\\:*?"<>|#%\p{Cc}]/u;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const tooLong = (segment: string) => encoder.encode(segment).byteLength > 255;
const isUnsafe = (segment: string) => unsafeSegment.test(segment) || tooLong(segment) || /[. ]$/.test(segment);
const textMember = /\.(?:opf|ncx|xhtml|html?|xml|svg|css)$/i;
const referenceAttribute = /(\s(?:href|src|xlink:href|full-path|URI|poster|data|srcset|style)\s*=\s*)("[^"]*"|'[^']*')/g;
const styleElement = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (value: string) => value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (match, hex, dec, name) =>
  hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : entities[name.toLowerCase()] ?? match);
const escapeAttribute = (value: string, quote: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(quote === '"' ? /"/g : /'/g, quote === '"' ? "&quot;" : "&apos;");

/** Unsafe path segments get short generated names; depth is kept so unparsed relative links between untouched members still work. */
function planRenames(names: string[]): Map<string, string> {
  const taken = new Set<string>(), segments = new Map<string, string>(), renames = new Map<string, string>();
  for (const name of names) { const parts = name.split("/"); for (let i = 1; i <= parts.length; i++) taken.add(parts.slice(0, i).join("/")); }
  let counter = 0;
  for (const name of names) {
    const parts = name.split("/");
    if (!parts.some(isUnsafe) || name === "mimetype" || name.startsWith("META-INF/")) continue;
    const renamed: string[] = [];
    parts.forEach((part, index) => {
      const original = parts.slice(0, index + 1).join("/");
      let next = segments.get(original);
      if (!next) {
        if (!isUnsafe(part)) next = part;
        else {
          const suffix = index === parts.length - 1 && /^\.[a-z0-9]{1,8}$/i.test(extension(part)) ? extension(part) : "";
          let candidate: string;
          do candidate = `${renamed.join("/")}${renamed.length ? "/" : ""}${index === parts.length - 1 ? "f" : "d"}${++counter}${suffix}`; while (taken.has(candidate));
          taken.add(candidate); next = candidate.split("/").at(-1)!;
        }
        segments.set(original, next);
      }
      renamed.push(next);
    });
    renames.set(name, renamed.join("/"));
  }
  return renames;
}

/**
 * Rewrites members whose names Kobo and FAT32 cannot handle, plus every OPF/NCX/XHTML/CSS reference to them.
 * A changed archive is stored uncompressed: it only feeds the KEPUB converter, which compresses its own output.
 */
export function sanitizeEpubMemberPaths(data: Uint8Array): ArchivePatch {
  const names = archiveMemberNames(data).map(canonicalZipMember), renames = planRenames(names);
  if (!renames.size) return { data, changed: false };
  const entries = readArchive(data);
  const known = new Set(names), rename = (name: string) => renames.get(name) ?? name;
  // container.xml and encryption.xml hold paths from the archive root, not relative links.
  // Renamed paths only keep segments without `%`, `#` or `?`, so they are written unencoded:
  // kepubify matches manifest hrefs to members without percent-decoding them.
  const resolve = (from: string, raw: string) => {
    const value = raw.trim(), root = from.startsWith("META-INF/");
    if (!value || value.startsWith("#") || value.startsWith("//")) return undefined;
    const target = resolveEpubReference(root ? "" : from, value, path => known.has(path));
    if (!target || !renames.has(target.path)) return undefined;
    const href = root ? rename(target.path) : relativeHref(rename(from), rename(target.path));
    return target.fragment ? `${href}#${target.fragment}` : href;
  };
  const css = (text: string, from: string) => rewriteCssUrls(text, url => resolve(from, url));
  const srcset = (value: string, from: string) => value.split(",").map(candidate => {
    const [url, ...descriptors] = candidate.trim().split(/\s+/);
    const next = url ? resolve(from, url) : undefined;
    return next ? [next, ...descriptors].join(" ") : candidate;
  }).join(",");
  const rewrite = (name: string, text: string) => {
    text = text.replace(referenceAttribute, (match, prefix: string, quoted: string) => {
      const attribute = prefix.trim().replace(/\s*=$/, ""), quote = quoted[0], value = decodeEntities(quoted.slice(1, -1));
      const next = attribute === "style" ? css(value, name) : attribute === "srcset" ? srcset(value, name) : resolve(name, value);
      return next === undefined || next === value ? match : `${prefix}${quote}${escapeAttribute(next, quote)}${quote}`;
    });
    return /\.(?:xhtml|html?|svg)$/i.test(name) ? text.replace(styleElement, (_match, open: string, body: string, close: string) => open + css(body, name) + close) : text;
  };
  const output: ArchiveMember[] = entries.map((entry, index) => {
    const name = names[index];
    if (!textMember.test(name)) return { name: rename(name), data: entry.data };
    const original = decoder.decode(entry.data), text = /\.css$/i.test(name) ? css(original, name) : rewrite(name, original);
    return { name: rename(name), data: text === original ? entry.data : encoder.encode(text) };
  });
  return { data: writeArchive(output, null), changed: true };
}
