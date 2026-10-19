import { strip, rstrip } from "./python";
export interface ThemeTemplate {
  theme_id: string;
  name: string;
  description: string | null;
  version: string;
  file_path: string;
  css: string;
}
export const DEFAULT_THEME_CSS =
  "body {\n  line-height: 1.75;\n}\np {\n  text-indent: 2rem;\n  margin: 0 0 0.8em;\n}\n.chapter-header {\n  margin: 1.25em 0 1em;\n}\n.chapter-stamp {\n  display: inline-block;\n  margin: 0 0 0.45em;\n  padding: 0.1em 0.5em;\n  font-size: 0.72em;\n  letter-spacing: 0.1em;\n  border: 1px solid currentColor;\n  border-radius: 999px;\n  text-indent: 0;\n}\n.chapter-title {\n  margin: 0;\n  font-size: 1.42em;\n  font-weight: 760;\n  line-height: 1.28;\n}\n.front-matter p.author {\n  text-align: center;\n  text-indent: 0;\n  margin: 0 0 1.5em;\n}\n.front-matter p.intro-label {\n  text-indent: 0;\n  font-weight: 700;\n  margin: 1.2em 0 0.6em;\n}\n.volume p, .volume .chapter-title {\n  text-indent: 0;\n}\n";
export function composeCss(
  themeCss?: string | null,
  customCss?: string | null,
): string {
  return [themeCss, customCss]
    .filter((s): s is string => Boolean(s && strip(s)))
    .map(strip)
    .join("\n\n");
}
export function themeTemplateFromData(
  data: Record<string, unknown>,
  filePath: string,
): ThemeTemplate {
  const id = String(
    data.id ||
      filePath
        .split("/")
        .at(-1)!
        .replace(/\.json$/, ""),
  );
  return {
    theme_id: id,
    name: String(data.name || id),
    description: data.description == null ? null : String(data.description),
    version: String(data.version || "1"),
    file_path: filePath,
    css: rstrip(String(data.css || "")),
  };
}
