export const MAX_CSS_LENGTH = 200_000;
export function validateCss(raw: string): string | null {
  if (!raw.trim()) return null;
  if ([...raw].length > MAX_CSS_LENGTH)
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
/** Preserve quoted text, comments and data URLs when formatting declarations. */
export function formatCssText(raw: string): string {
  let out = "",
    indent = 0,
    quote = "",
    comment = false,
    escape = false,
    pendingSpace = false,
    parentheses = 0;
  const pad = () => {
    out += "  ".repeat(Math.max(0, indent));
  };
  const space = () => {
    if (pendingSpace && out && !out.endsWith(" ") && !out.endsWith("\n"))
      out += " ";
    pendingSpace = false;
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i],
      next = raw[i + 1];
    if (comment) {
      out += ch;
      if (ch === "*" && next === "/") {
        out += "/";
        i++;
        comment = false;
        out += "\n";
        pad();
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      space();
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "*") {
      space();
      comment = true;
      out += "/*";
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (ch === "(") parentheses++;
    else if (ch === ")") parentheses = Math.max(0, parentheses - 1);
    if (!parentheses && ch === "{") {
      out = out.trimEnd() + " {\n";
      indent++;
      pendingSpace = false;
      pad();
      continue;
    }
    if (!parentheses && ch === "}") {
      indent = Math.max(0, indent - 1);
      out = out.trimEnd() + "\n";
      pad();
      out += "}";
      pendingSpace = false;
      if (raw.slice(i + 1).trim()) {
        out += "\n";
        pad();
      }
      continue;
    }
    if (!parentheses && ch === ";") {
      out = out.trimEnd() + ";\n";
      pendingSpace = false;
      pad();
      continue;
    }
    space();
    out += ch;
  }
  return out.trim();
}
