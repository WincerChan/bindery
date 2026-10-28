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
export function themePreviewDocument(css: string, tokens = ""): string {
  const safe = css.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><style>:root{${tokens.replace(/<\/style/gi, "<\\/style")}}html,body{height:100%}body{margin:0;background:var(--color-surface);color:var(--color-ink);font-family:var(--font-display);font-size:12px;line-height:1.8}.spread{display:flex;height:100%;min-height:100vh}.page{flex:1 1 0;min-width:0;box-sizing:border-box;background:var(--color-surface)}.opening{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:40px 24px;border-radius:4px 0 0 4px;background:linear-gradient(270deg,rgba(32,41,35,.12) 0,rgba(32,41,35,0) 24px),var(--color-surface)}.opening .volume{margin:0;letter-spacing:.4em;color:var(--color-ink-4)}.opening .chapter{margin:0;font-size:22px;font-weight:600;letter-spacing:.2em}.opening .rule{width:24px;height:1px;background:var(--color-accent)}.text{padding:36px 24px;border-radius:0 4px 4px 0;background:linear-gradient(90deg,rgba(32,41,35,.10) 0,rgba(32,41,35,0) 20px),var(--color-surface)}.text p{margin:0;text-indent:2em;text-align:justify}</style><style>${safe}</style></head><body><div class="spread"><section class="page opening" aria-label="章节扉页"><p class="volume">卷 一</p><p class="chapter">示例章节</p><span class="rule" aria-hidden="true"></span></section><section class="page text" aria-label="正文预览"><p>这是一段用于预览主题 CSS 的正文内容。你可以调整字体、行高、缩进与边距，观察阅读体验变化。</p><p>建议在这里模拟你常读的文本密度与段落风格，然后再保存并写回到 EPUB。</p></section></div></body></html>`;
}
