import { strip } from "./text";

export const MAX_CSS_LENGTH = 200_000;
export function validateCss(raw: string): string | null {
  if (!strip(raw)) return null;
  if (Array.from(raw).length > MAX_CSS_LENGTH)
    return `CSS 过长（超过 ${MAX_CSS_LENGTH} 字符）`;
  if (raw.includes("\0")) return "CSS 包含非法字符";
  let depth = 0,
    quote = "",
    escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      if (end < 0) return "CSS 注释未闭合";
      i = end + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return "CSS 花括号不匹配";
  }
  return quote ? "CSS 字符串未闭合" : depth ? "CSS 花括号不匹配" : null;
}
