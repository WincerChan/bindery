export interface StripCssOptions {
  stripFonts?: boolean; stripImages?: boolean; isImage: (url: string) => boolean;
  /** Drop margin/padding set on the page itself (`html`, `body`, `:root`), leaving the reader's own margins. */
  stripPageMargins?: boolean;
  /** Remove line-height declarations, including only the `/line-height` part of a `font` shorthand. */
  stripLineHeight?: boolean;
  /** Remove vertical outer margins, except on heading rules and headings. */
  stripParagraphSpacing?: boolean;
  /** The text is the inline style of an `html` or `body` element. */
  pageRoot?: boolean;
  /** The text is the inline style of an `h1`–`h6` element. */
  heading?: boolean;
}
const pageRootSelector = (selectors: string) => selectors.replace(/\/\*[\s\S]*?\*\//g, "").split(",").every(selector => /^\s*(?:html|body|:root)\s*$/i.test(selector));
const headingType = /^h[1-6]$/i;
const marginBlock = /^(?:margin-(?:top|bottom|block|block-start|block-end))$/;
/** A heading is a type selector in any selector of the list, not `.h1`, `#h1`, an attribute value or a string. */
function headingSelector(css: string): boolean {
  const list = tokens(css);
  let brackets = 0, parens = 0;
  for (let i = 0; i < list.length; i++) {
    const value = list[i].value;
    if (value === "[") brackets++; else if (value === "]") brackets--; else if (value === "(") parens++; else if (value === ")") parens--;
    if (brackets || parens || !headingType.test(value)) continue;
    const previous = list[i - 1];
    if (!previous || css.slice(previous.end, list[i].start) || [",", ">", "+", "~", "|"].includes(previous.value)) return true;
  }
  return false;
}
/** Group a declaration value into its top-level components; whitespace/comments separate them. */
function valueGroups(css: string, list: ReturnType<typeof tokens>, from: number, to: number) {
  const groups: Array<{ start: number; end: number }> = [];
  let parens = 0, brackets = 0;
  for (let i = from; i < to; i++) {
    const token = list[i], value = token.value, gap = i > from ? css.slice(list[i - 1].end, token.start) : "";
    if (!groups.length || (parens === 0 && brackets === 0 && gap !== "")) groups.push({ start: token.start, end: token.end });
    else groups.at(-1)!.end = token.end;
    if (value === "(") parens++; else if (value === ")") parens--; else if (value === "[") brackets++; else if (value === "]") brackets--;
  }
  return groups;
}

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
    // An unquoted url( ... ) is one token: "/*" inside it is part of the URL, not a comment.
    // Contents with quotes keep the normal tokenization (a quoted URL, possibly after a comment).
    if (css[at] === "(" && result.at(-1)!.value.toLowerCase() === "url") {
      let urlStart = at + 1, close = urlStart;
      while (/\s/.test(css[urlStart] ?? "")) urlStart++;
      while (close < css.length && css[close] !== ")" && !/["'(]/.test(css[close])) close += css[close] === "\\" ? 2 : 1;
      if (css[close] === ")") {
        let urlEnd = close;
        while (urlEnd > urlStart && /\s/.test(css[urlEnd - 1])) urlEnd--;
        result.push({ value: "(", start: at, end: at + 1 });
        if (urlEnd > urlStart) result.push({ value: unescapeCss(css.slice(urlStart, urlEnd)), start: urlStart, end: urlEnd });
        at = close;
      }
    }
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
  if (!options.stripFonts && !options.stripImages && !options.stripPageMargins && !options.stripLineHeight && !options.stripParagraphSpacing) return css;
  const list = tokens(css), removed: Array<[number, number]> = [], replacements: Array<[number, number, string]> = [];
  const declaration = (start: number, end: number, from: number, to: number, pageRoot: boolean, heading: boolean) => {
    if (list[start + 1]?.value !== ":") return;
    const property = list[start].value.toLowerCase();
    // The font shorthand also sets font-family; leaving it would restore a publisher font.
    let drop = options.stripFonts && ["font-family", "font"].includes(property);
    // Explicit zeros stay: removing them would bring back the renderer's default body margin.
    if (pageRoot && options.stripPageMargins && /^(?:margin|padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$/.test(property)
      && list.slice(start + 2, end).some(token => !/^(?:[+-]?0+(?:\.0*)?[a-z%]*|!|important)$/i.test(token.value))) drop = true;
    if (options.stripImages) for (let i = start + 2; i < end; i++) {
      if (list[i].value.toLowerCase() !== "url" || list[i + 1]?.value !== "(") continue;
      let close = i + 2; while (close < end && list[close].value !== ")") close++;
      const url = unquote(list.slice(i + 2, close).map(token => token.value).join(""));
      if (options.isImage(url)) drop = true;
    }
    if (drop) { removed.push([from, to]); return; }
    let valueEnd = end;
    const important = valueEnd - start >= 4 && list[valueEnd - 1]?.value.toLowerCase() === "important" && list[valueEnd - 2]?.value === "!";
    if (important) valueEnd -= 2;
    if (options.stripLineHeight && property === "line-height") { removed.push([from, to]); return; }
    if (options.stripLineHeight && property === "font") {
      let parens = 0, brackets = 0;
      for (let i = start + 2; i < valueEnd; i++) {
        const value = list[i].value;
        if (value === "(") parens++; else if (value === ")") parens--; else if (value === "[") brackets++; else if (value === "]") brackets--;
        else if (value === "/" && !parens && !brackets) {
          // Drop only the line-height component, keeping the size and family (and any !important).
          let last = i, depthParens = 0, depthBrackets = 0;
          for (let j = i + 1; j < valueEnd; j++) {
            const next = list[j].value, gap = css.slice(list[j - 1].end, list[j].start);
            if (j > i + 1 && depthParens === 0 && depthBrackets === 0 && gap !== "") break;
            last = j;
            if (next === "(") depthParens++; else if (next === ")") depthParens--; else if (next === "[") depthBrackets++; else if (next === "]") depthBrackets--;
          }
          let removeFrom = list[i].start;
          const previous = list[i - 1], gap = previous ? css.slice(previous.end, removeFrom) : "";
          if (gap && /^\s*$/.test(gap)) removeFrom = previous.end;
          replacements.push([removeFrom, list[last].end, ""]);
          break;
        }
      }
    }
    if (options.stripParagraphSpacing && !heading) {
      if (marginBlock.test(property)) { removed.push([from, to]); return; }
      if (property === "margin") {
        const groups = valueGroups(css, list, start + 2, valueEnd), count = groups.length;
        if (count >= 1 && count <= 4) {
          const values = groups.map(group => css.slice(group.start, group.end));
          const right = values[count >= 2 ? 1 : 0], left = count === 4 ? values[3] : right, suffix = important ? " !important" : "";
          replacements.push([list[start].start, list[end - 1].end, `margin-left: ${left}${suffix}; margin-right: ${right}${suffix}`]);
        }
      }
    }
  };
  // Only rules whose every selector is the page root qualify: `body.cover` and `body p` keep their spacing.
  function block(start: number, end: number, from: number, to: number, pageRoot: boolean, heading: boolean) {
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
        else {
          const selector = list[statement] !== undefined && statement < i ? css.slice(list[statement].start, list[i].start) : "";
          block(i + 1, close, list[i].end, list[close]?.start ?? to, pageRootSelector(selector), headingSelector(selector));
        }
        i = close; statement = i + 1; statementFrom = list[i]?.end ?? to;
      } else if (value === ";") {
        declaration(statement, i, statementFrom, list[i].end, pageRoot, heading); statement = i + 1; statementFrom = list[i].end;
      }
    }
    declaration(statement, end, statementFrom, to, pageRoot, heading);
  }
  block(0, list.length, 0, css.length, Boolean(options.pageRoot), Boolean(options.heading));
  const changes: Array<[number, number, string]> = [...removed.map(([from, to]): [number, number, string] => [from, to, ""]), ...replacements];
  let result = "", at = 0;
  for (const [from, to, replacement] of changes.sort((a, b) => a[0] - b[0])) { result += css.slice(at, from) + replacement; at = to; }
  return result + css.slice(at);
}
