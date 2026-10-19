// Python str.strip / re Unicode whitespace excludes U+FEFF, includes U+0085 and U+001C–001F.
export const PY_SPACE =
  "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export function strip(text: string): string {
  return text.replace(new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu"), "");
}
export function rstrip(text: string): string {
  return text.replace(new RegExp(`[${PY_SPACE}]+$`, "u"), "");
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
  // Translate Python's Unicode character classes and named capture syntax.
  pattern = pattern
    .replace(/\(\?P<([^>]+)>/g, "(?<$1>")
    .replace(/\(\?P=([^)]+)\)/g, "\\k<$1>")
    .replace(/\\s/g, `[${PY_SPACE}]`)
    .replace(/\\S/g, `[^${PY_SPACE}]`)
    .replace(/\\d/g, "\\p{Decimal_Number}")
    .replace(/\\D/g, "\\P{Decimal_Number}")
    .replace(/\\w/g, "[\\p{L}\\p{N}_]")
    .replace(/\\W/g, "[^\\p{L}\\p{N}_]")
    .replace(/\\A/g, "^")
    .replace(/\\Z/g, "$(?![\\s\\S])");
  // Python templates sometimes put \\d inside a character class. JS Unicode mode supports this.
  return new RegExp(pattern, [...new Set(flags)].join(""));
}
