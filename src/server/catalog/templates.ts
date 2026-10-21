import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_RULE_CONFIG, parseBook } from "../../core/parsing";
import { RuleTemplateError, validateRuleTemplateJson } from "../../core/rules";
import { strip } from "../../core/text";
import { getRule, getTheme, loadRuleTemplates, loadThemeTemplates, templateDirectory } from "../templates";
import { HttpError, requireEntity, missingEntity } from "../http";
import type { LibraryStorage } from "../storage";
import { validateThemeCss } from "./theme-css";

// Only serializable display data crosses the RPC boundary; compiled regexes and paths stay here.
const summary = (t: { name: string; description: string | null; version: string }) => ({ name: t.name, description: t.description, version: t.version });
function requireRule(id: string) {
  const rule = loadRuleTemplates().find(t => t.rule_id === id);
  return requireEntity(rule, "rule");
}
function requireTheme(id: string) {
  const theme = loadThemeTemplates().find(t => t.theme_id === id);
  return requireEntity(theme, "theme");
}
export function ruleEditor(id: string) {
  const rule = requireRule(id);
  return { ...summary(rule), id: rule.rule_id, raw: readFileSync(rule.file_path, "utf8"), saved: false, error: null as string | null };
}
export function themeEditor(id: string) {
  const theme = requireTheme(id);
  return { ...summary(theme), id: theme.theme_id, raw: theme.css, saved: false, error: null as string | null };
}
export type EditorData = ReturnType<typeof ruleEditor>;
export function catalogPage(search: Record<string, string>) {
  const rules = loadRuleTemplates(), themes = loadThemeTemplates();
  const ruleId = rules.find(t => t.rule_id === strip(search.rule_id || ""))?.rule_id || rules[0]?.rule_id || "default";
  const themeId = themes.find(t => t.theme_id === strip(search.theme_id || ""))?.theme_id || themes[0]?.theme_id || "default";
  return {
    rules: rules.map(t => ({ ...summary(t), id: t.rule_id })),
    themes: themes.map(t => ({ ...summary(t), id: t.theme_id })),
    tab: strip(search.tab || "") === "themes" ? "themes" : "parsing",
    ruleId, themeId, error: strip(search.error || ""),
    editor: strip(search.tab || "") === "themes" ? (themes.length ? themeEditor(themeId) : null) : (rules.length ? ruleEditor(ruleId) : null),
  };
}
export function saveRule(id: string, raw: string): EditorData {
  const rule = requireRule(id);
  let data: Record<string, unknown>;
  try { data = validateRuleTemplateJson(id, raw); }
  catch (error) {
    if (!(error instanceof RuleTemplateError)) throw error;
    return { ...summary(rule), id, raw, saved: false, error: error.message };
  }
  writeFileSync(rule.file_path, JSON.stringify(data, null, 2), "utf8");
  return { ...ruleEditor(id), saved: true };
}
export function saveTheme(id: string, raw: string): EditorData {
  const theme = requireTheme(id), error = validateThemeCss(raw);
  if (error) return { ...summary(theme), id, raw, saved: false, error: `主题 CSS 校验失败：${error}` };
  let data: Record<string, unknown>;
  try { data = JSON.parse(readFileSync(theme.file_path, "utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw new HttpError(400, "Theme file is not valid JSON"); throw error; }
  data.css = raw;
  writeFileSync(theme.file_path, JSON.stringify(data, null, 2), "utf8");
  return { ...themeEditor(id), saved: true };
}
export function newTemplate(kind: "rules" | "themes"): string {
  const dir = templateDirectory(kind);
  let id: string;
  do { id = `${kind === "rules" ? "custom" : "theme"}-${randomBytes(4).toString("hex")}`; }
  while (existsSync(join(dir, `${id}.json`)));
  let data: Record<string, unknown>;
  if (kind === "rules") {
    let seed: Record<string, unknown> | undefined;
    if (existsSync(join(dir, "default.json"))) {
      try { seed = validateRuleTemplateJson("default", readFileSync(join(dir, "default.json"), "utf8")); }
      catch (error) { if (!(error instanceof RuleTemplateError)) throw error; }
    }
    const { rule_id: _, ...config } = DEFAULT_RULE_CONFIG;
    data = { ...(seed || config), id, name: "新规则", description: "自定义切章规则", version: "1" };
  } else data = { id, name: "新样式", description: "自定义渲染主题", version: "1", css: getTheme("default")?.css || "" };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(data, null, 2), "utf8");
  return templateUrl(kind, id);
}
export function templateUrl(kind: "rules" | "themes", id: string) {
  return `/rules?tab=${kind === "rules" ? "parsing" : "themes"}&${kind === "rules" ? "rule_id" : "theme_id"}=${encodeURIComponent(id)}`;
}
export function deleteTemplate(kind: "rules" | "themes", id: string, library: LibraryStorage): string {
  if (id === "default") throw new HttpError(400, "默认模板不可删除");
  const template = kind === "rules" ? requireRule(id) : requireTheme(id);
  if ([...library.listBooks(), ...library.listArchivedBooks()].some(meta => strip((kind === "rules" ? meta.rule_template : meta.theme_template) || "") === id)) {
    return `${templateUrl(kind, id)}&error=${encodeURIComponent("模板已被书籍引用，无法删除")}`;
  }
  try { unlinkSync(template.file_path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") missingEntity(kind === "rules" ? "rule" : "theme"); throw error; }
  return templateUrl(kind, "default");
}
export function testRule(sample: string, ruleId = "default") {
  if (!strip(sample)) return null;
  const book = parseBook(sample, "sample", getRule(ruleId).rules);
  return { volumes: book.volumes.length, chapters: book.root_chapters.length + book.volumes.reduce((n, v) => n + v.chapters.length, 0), toc: book.spine.slice(0, 15).map(item => item.title) };
}
export type RulePreviewData = ReturnType<typeof testRule>;
