import { HtmlTokenizer } from "./html-tokenizer";

// Block boundaries separate words; inline markup and comments do not split them.
const wordCountBlocks = new Set("address article aside blockquote br caption dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table td th tr ul".split(" "));
const wordCountIgnored = new Set(["head", "style", "script"]);
const cjkLetter = String.raw`(?:(?=\p{Letter})[\p{Script=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]|[\u3007\uAC00-\uD7A3])`,
  latinOrDigit = String.raw`(?:(?=\p{Letter})\p{Script=Latin}|\p{Decimal_Number})`,
  latinRun = `${latinOrDigit}(?:${latinOrDigit}|\\p{Mark})*`,
  countedWords = new RegExp(`(${cjkLetter}+)|${latinRun}(?:['’-]${latinRun})*`, "gu");
/** Count visible EPUB document text, without building a DOM or counting attributes. */
export function countDocumentWords(html: string): number {
  const tokenizer = new HtmlTokenizer(html), parts: string[] = [];
  let ignored: string | null = null;
  for (let token = tokenizer.next(); token; token = tokenizer.next()) {
    if (ignored) {
      if (token.type === "end" && token.name === ignored) ignored = null;
      continue;
    }
    if (token.type === "text") parts.push(token.data);
    else if (token.type === "start" || token.type === "end") {
      const name = token.name.split(":").at(-1)!;
      if (token.type === "start" && wordCountIgnored.has(name)) {
        if (!token.selfClosing) ignored = token.name;
      } else if (wordCountBlocks.has(name)) parts.push(" ");
    }
  }
  // Count CJK runs by code point, and Latin/digit runs (including inner ’/'/-) once.
  // Combining marks keep decomposed Latin accents in the same word.
  let count = 0;
  for (const match of parts.join("").matchAll(countedWords)) {
    if (match[1]) { for (const _ of match[1]) count++; }
    else count++;
  }
  return count;
}

// Legacy str.strip / re Unicode whitespace excludes U+FEFF, includes U+0085 and U+001C–001F.
export const SPACE =
  "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export function strip(text: string): string {
  return text.replace(new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu"), "");
}
export function rstrip(text: string): string {
  return text.replace(new RegExp(`[${SPACE}]+$`, "u"), "");
}
export function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
  if (!lines.at(-1)) lines.pop();
  return lines;
}
export function compilePattern(pattern: string): RegExp {
  let flags = "u";
  const inline = pattern.match(/^\(\?([ims]+)\)/);
  if (inline) {
    flags += inline[1];
    pattern = pattern.slice(inline[0].length);
  }
  if (!flags.includes("s")) {
    let translated = "",
      escaped = false,
      inClass = false;
    for (const c of pattern) {
      if (escaped) {
        translated += c;
        escaped = false;
        continue;
      }
      if (c === "\\") {
        translated += c;
        escaped = true;
        continue;
      }
      if (c === "[") inClass = true;
      if (c === "]") inClass = false;
      translated += c === "." && !inClass ? "[^\\n]" : c;
    }
    pattern = translated;
  }
  // Translate the legacy regex dialect's Unicode classes and named capture syntax.
  pattern = pattern
    .replace(/\(\?P<([^>]+)>/g, "(?<$1>")
    .replace(/\(\?P=([^)]+)\)/g, "\\k<$1>")
    .replace(/\\s/g, `[${SPACE}]`)
    .replace(/\\S/g, `[^${SPACE}]`)
    .replace(/\\d/g, "\\p{Decimal_Number}")
    .replace(/\\D/g, "\\P{Decimal_Number}")
    .replace(/\\w/g, "[\\p{L}\\p{N}_]")
    .replace(/\\W/g, "[^\\p{L}\\p{N}_]")
    .replace(/\\A/g, "^")
    .replace(/\\Z/g, "$(?![\\s\\S])");
  // Legacy templates sometimes put \\d inside a character class. JS Unicode mode supports this.
  return new RegExp(pattern, [...new Set(flags)].join(""));
}
