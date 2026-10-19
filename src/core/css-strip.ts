export interface StripCssOptions { stripFonts?: boolean; stripImages?: boolean; isImage: (url: string) => boolean }

/** Decode CSS identifiers and URL strings, including escaped property / at-rule names. */
function unescapeCss(text: string): string {
  return text.replace(/\\(?:\r\n|[\r\n\f])/g, "").replace(/\\([\da-f]{1,6}\s?|[^\r\n\f])/gi, (_, value: string) => {
    const hex = /^[\da-f]{1,6}\s?$/i.test(value);
    const code = hex ? parseInt(value.trim(), 16) : 0;
    return hex ? String.fromCodePoint(code && code <= 0x10ffff ? code : 0xfffd) : value;
  });
}
function tokens(css: string): Array<{ value: string; start: number; end: number }> {
  const result: ReturnType<typeof tokens> = [];
  for (let at = 0; at < css.length;) {
    const start = at, ch = css[at++];
    if (/\s/.test(ch)) continue;
    if (ch === "/" && css[at] === "*") { const end = css.indexOf("*/", at + 1); at = end < 0 ? css.length : end + 2; continue; }
    if (ch === '"' || ch === "'") {
      while (at < css.length) { const next = css[at++]; if (next === "\\") at++; else if (next === ch) break; }
    } else if (/[\w@#-]|[^\x00-\x7f]|\\/.test(ch)) {
      at = start;
      while (at < css.length) {
        if (css[at] === "\\") {
          at++; const escaped = /^[\da-f]{1,6}\s?/i.exec(css.slice(at)); at += escaped ? escaped[0].length : 1;
        } else if (/[\w@#-]|[^\x00-\x7f]/.test(css[at])) at++; else break;
      }
    }
    result.push({ value: unescapeCss(css.slice(start, at)), start, end: at });
  }
  return result;
}
const unquote = (text: string) => text.replace(/^("[\s\S]*"|'[\s\S]*')$/, value => value.slice(1, -1));

/** Rewrite resource references, including both forms of @import, without matching strings or comments. */
export function rewriteCssUrls(css: string, rewrite: (url: string) => string | undefined): string {
  const list = tokens(css), edits: Array<[number, number, string]> = [];
  for (let i = 0; i < list.length; i++) {
    let start: number, end: number, url: string;
    if (list[i].value.toLowerCase() === "url" && list[i + 1]?.value === "(") {
      let close = i + 2; while (close < list.length && list[close].value !== ")") close++;
      if (close === list.length) continue;
      start = list[i + 1].end; end = list[close].start;
      url = unquote(list.slice(i + 2, close).map(token => token.value).join("")); i = close;
    } else if (list[i].value.toLowerCase() === "@import" && /^["']/.test(list[i + 1]?.value ?? "")) {
      const token = list[++i]; start = token.start; end = token.end; url = unquote(token.value);
    } else continue;
    const replacement = rewrite(url);
    if (replacement !== undefined) edits.push([start, end, JSON.stringify(replacement)]);
  }
  let result = "", at = 0;
  for (const [start, end, replacement] of edits) { result += css.slice(at, start) + replacement; at = end; }
  return result + css.slice(at);
}

/** Token-aware removal preserves unrelated declarations, strings, comments and rule order. */
export function stripCss(css: string, options: StripCssOptions): string {
  if (!options.stripFonts && !options.stripImages) return css;
  const list = tokens(css), removed: Array<[number, number]> = [];
  const declaration = (start: number, end: number, from: number, to: number) => {
    if (list[start + 1]?.value !== ":") return;
    const property = list[start].value.toLowerCase();
    // The font shorthand also sets font-family; leaving it would restore a publisher font.
    let drop = options.stripFonts && ["font-family", "font"].includes(property);
    if (options.stripImages) for (let i = start + 2; i < end; i++) {
      if (list[i].value.toLowerCase() !== "url" || list[i + 1]?.value !== "(") continue;
      let close = i + 2; while (close < end && list[close].value !== ")") close++;
      const url = unquote(list.slice(i + 2, close).map(token => token.value).join(""));
      if (options.isImage(url)) drop = true;
    }
    if (drop) removed.push([from, to]);
  };
  function block(start: number, end: number, from: number, to: number) {
    let statement = start, statementFrom = from, parens = 0, brackets = 0;
    for (let i = start; i < end; i++) {
      const value = list[i].value;
      if (value === "(") parens++; else if (value === ")") parens--;
      else if (value === "[") brackets++; else if (value === "]") brackets--;
      if (parens || brackets) continue;
      if (value === "{") {
        let close = i + 1, depth = 1;
        for (; close < end; close++) { if (list[close].value === "{") depth++; if (list[close].value === "}" && --depth === 0) break; }
        if (options.stripFonts && list[statement]?.value.toLowerCase() === "@font-face") removed.push([statementFrom, list[close]?.end ?? to]);
        else block(i + 1, close, list[i].end, list[close]?.start ?? to);
        i = close; statement = i + 1; statementFrom = list[i]?.end ?? to;
      } else if (value === ";") {
        declaration(statement, i, statementFrom, list[i].end); statement = i + 1; statementFrom = list[i].end;
      }
    }
    declaration(statement, end, statementFrom, to);
  }
  block(0, list.length, 0, css.length);
  let result = "", at = 0;
  for (const [from, to] of removed.sort((a, b) => a[0] - b[0])) { result += css.slice(at, from); at = to; }
  return result + css.slice(at);
}
