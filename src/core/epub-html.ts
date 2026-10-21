import { strip } from "./text";
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
export function stripBinderyCssLinks(text: string): string {
  return text.replace(
    /<link\b[^>]*href=['"][^'"]*bindery(?:-overlay)?\.css[^'"]*['"][^>]*>\s*/gi,
    "",
  );
}
export function stripAllCssHtml(text: string): string {
  return text
    .replace(/<\?xml-stylesheet\b[^>]*\?>\s*/gi, "")
    .replace(
      /<link\b[^>]*\brel\s*=\s*['"][^'"]*\bstylesheet\b[^'"]*['"][^>]*>\s*/gi,
      "",
    )
    .replace(/<link\b[^>]*\brel\s*=\s*stylesheet\b[^>]*>\s*/gi, "")
    .replace(/<style\b[^>]*>.*?<\/style>\s*/gis, "");
}
export function appendStylesheetLink(text: string, href: string): string {
  const tag = `<link rel="stylesheet" type="text/css" href="${escapeHtml(href)}" />`;
  if (/<head([^>]*)\s*\/>/i.test(text))
    return text.replace(
      /<head([^>]*)\s*\/>/i,
      (_, attrs: string) => `<head${attrs}>${tag}</head>`,
    );
  const closing = /<\/head>/i.exec(text);
  if (closing)
    return text.slice(0, closing.index) + tag + text.slice(closing.index);
  const opening = /<head[^>]*>/i.exec(text);
  if (opening)
    return (
      text.slice(0, opening.index + opening[0].length) +
      tag +
      text.slice(opening.index + opening[0].length)
    );
  return `<head>${tag}</head>${text}`;
}
export function patchDocHtmlBinderyCss(
  text: string,
  href: string | null,
  stripOriginalCss = false,
): string {
  const stripped = stripOriginalCss
    ? stripAllCssHtml(text)
    : stripBinderyCssLinks(text);
  return href ? appendStylesheetLink(stripped, href) : stripped;
}
export function stripWebpRefsFromHtml(text: string): string {
  return text
    .replace(
      /<source\b[^>]*(?:src|srcset)\s*=\s*['"][^'"]*\.webp(?:[?#][^'"]*)?['"][^>]*>\s*/gi,
      "",
    )
    .replace(
      /<img\b[^>]*\bsrc\s*=\s*['"][^'"]*\.webp(?:[?#][^'"]*)?['"][^>]*>\s*/gi,
      "",
    )
    .replace(
      /\s+(?:src|href|poster|data-src)\s*=\s*(['"])[^'"]*\.webp(?:[?#][^'"]*)?\1/gi,
      "",
    )
    .replace(/\s+srcset\s*=\s*(['"])[^'"]*\.webp[^'"]*\1/gi, "");
}
// Preserve the reference's double-escaped regexes; these helpers are NOT a sanitizer.
export function stripScripts(text: string): string {
  return text.replace(/<script\\b[^>]*>.*?<\/script>/gis, "");
}
export function injectBase(text: string, baseHref: string): string {
  const base = `<base href="${escapeHtml(baseHref)}" />`;
  text = text.replace(/<base\\b[^>]*>\\s*/gi, "");
  if (/<head([^>]*)\\s*\/>/i.test(text))
    return text.replace(
      /<head([^>]*)\\s*\/>/i,
      (_, attrs: string) => `<head${attrs}>${base}</head>`,
    );
  const match = /<head[^>]*>/i.exec(text);
  return match
    ? text.slice(0, match.index + match[0].length) +
        base +
        text.slice(match.index + match[0].length)
    : `<head>${base}</head>${text}`;
}
export function splitChapterTitle(
  title: string,
  kind: string,
): [string | null, string] {
  if (kind !== "chapter") return [null, title];
  const match =
    /^\s*(第[0-9零〇一二两三四五六七八九十百千万亿\p{Decimal_Number}]+章)\s*[:：、.\-·]?\s*(.+)\s*$/u.exec(
      title || "",
    );
  return match && strip(match[2])
    ? [strip(match[1]), strip(match[2])]
    : [null, title];
}
