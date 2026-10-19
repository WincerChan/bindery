import { strip } from "../../core/python";

// Theme-specific validation mirrors bindery/css.py; it deliberately accepts arbitrary CSS syntax.
export function validateThemeCss(raw: string): string | null {
  if (!strip(raw)) return null;
  if (Array.from(raw).length > 200_000) return "CSS 过长（超过 200000 字符）";
  if (raw.includes("\0")) return "CSS 包含非法字符";
  let depth = 0, quote = "", escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      if (end < 0) return "CSS 注释未闭合";
      i = end + 1;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return "CSS 花括号不匹配";
  }
  return quote ? "CSS 字符串未闭合" : depth ? "CSS 花括号不匹配" : null;
}
