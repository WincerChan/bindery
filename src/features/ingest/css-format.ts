/** Presentation-only formatting. Validation remains the shared core's concern. */
export function formatCss(raw: string): string {
  let output = "", indent = 0, quote = "", comment = false, escaped = false, space = false;
  const pad = () => "  ".repeat(Math.max(0, indent));
  const flushSpace = () => { if (space && output && !/[ \n]$/.test(output)) output += " "; space = false; };
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i], next = raw[i + 1];
    if (comment) {
      output += char;
      if (char === "*" && next === "/") { output += "/"; i++; comment = false; output += "\n" + pad(); }
    } else if (quote) {
      output += char;
      if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") { flushSpace(); quote = char; output += char; }
    else if (char === "/" && next === "*") { flushSpace(); comment = true; output += "/*"; i++; }
    else if (/\s/.test(char)) space = true;
    else if (char === "{") { output = output.trimEnd() + " {\n"; indent++; output += pad(); space = false; }
    else if (char === "}") { indent = Math.max(0, indent - 1); output = output.trimEnd() + "\n" + pad() + "}"; if (raw.slice(i + 1).trim()) output += "\n" + pad(); space = false; }
    else if (char === ";") { output = output.trimEnd() + ";\n" + pad(); space = false; }
    else { flushSpace(); output += char; }
  }
  return output.trim();
}
