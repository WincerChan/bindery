export function formatCssText(raw: string): string {
  let out = "", indent = 0, quote = "", comment = false, escape = false, pendingSpace = false, brackets = 0;
  const pad = () => { out += "  ".repeat(indent); };
  const space = () => { if (pendingSpace && out && !out.endsWith(" ") && !out.endsWith("\n")) out += " "; pendingSpace = false; };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!, next = raw[i + 1];
    if (comment) { out += ch; if (ch === "*" && next === "/") { out += "/"; i++; comment = false; } continue; }
    if (quote) { out += ch; if (escape) escape = false; else if (ch === "\\") escape = true; else if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { space(); quote = ch; out += ch; continue; }
    if (ch === "/" && next === "*") { space(); comment = true; out += "/*"; i++; continue; }
    if (/\s/.test(ch)) { pendingSpace = true; continue; }
    if (ch === "(" || ch === "[") brackets++;
    if (ch === ")" || ch === "]") brackets = Math.max(0, brackets - 1);
    if (!brackets && ch === "{") { out = out.trimEnd() + " {\n"; indent++; pad(); pendingSpace = false; }
    else if (!brackets && ch === "}") { out = out.trimEnd() + "\n"; indent = Math.max(0, indent - 1); pad(); out += "}"; if (raw.slice(i + 1).trim()) { out += "\n"; pad(); } pendingSpace = false; }
    else if (!brackets && ch === ";") { out = out.trimEnd() + ";\n"; pad(); pendingSpace = false; }
    else { space(); out += ch; }
  }
  return out.trim();
}
export function themePreviewDocument(css: string): string {
  const safe = css.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><style>body{margin:0;padding:32px 20px;background:#fff;color:#171717}.page{max-width:600px;margin:auto}</style><style>${safe}</style></head><body><div class="page"><h2>第一章：CSS 预览</h2><p>这是一段用于预览主题 CSS 的正文内容。你可以调整字体、行高、缩进与边距，观察阅读体验变化。</p><p>建议在这里模拟你常读的文本密度与段落风格，然后再保存并写回到 EPUB。</p></div></body></html>`;
}
