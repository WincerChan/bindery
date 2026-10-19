export { MAX_CSS_LENGTH, validateCss } from "../../core/css";
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
