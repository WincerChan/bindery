import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { readEnv } from "./env";
import { projectRoot } from "./paths";
import { DEFAULT_RULE_CONFIG } from "../core/parsing";
import { ruleTemplateFromData } from "../core/rules";
import { DEFAULT_THEME_CSS, themeTemplateFromData } from "../core/themes";
export function templateDirectory(kind: "rules" | "themes"): string {
  const path = resolve(
    readEnv(kind === "rules" ? "BINDERY_RULES_DIR" : "BINDERY_THEMES_DIR") ||
      resolve(
        readEnv("BINDERY_TEMPLATE_DIR") ||
          resolve(projectRoot, ".bindery-user-templates"),
        kind,
      ),
  );
  mkdirSync(path, { recursive: true });
  return path;
}
function load<T>(
  kind: "rules" | "themes",
  convert: (data: Record<string, unknown>, file: string) => T,
): T[] {
  const dir = templateDirectory(kind),
    file = resolve(dir, "default.json");
  if (!existsSync(file)) {
    const seed = resolve(
      projectRoot,
      "bindery-templates",
      kind,
      "default.json",
    );
    if (existsSync(seed)) copyFileSync(seed, file);
    else
      writeFileSync(
        file,
        JSON.stringify(
          kind === "rules"
            ? {
                id: "default",
                ...DEFAULT_RULE_CONFIG,
                description: "默认切章规则",
                version: "1",
              }
            : {
                id: "default",
                name: "默认样式",
                description: "生成 EPUB 的默认排版（可全局复用）",
                version: "1",
                css: DEFAULT_THEME_CSS,
              },
          null,
          2,
        ),
      );
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const path = resolve(dir, name);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) return [];
        throw error;
      }
      return [convert(data, path)];
    });
}
export const loadRuleTemplates = () => load("rules", ruleTemplateFromData);
export const loadThemeTemplates = () => load("themes", themeTemplateFromData);
export function getRule(id: string) {
  const templates = loadRuleTemplates();
  return templates.find((t) => t.rule_id === id) ?? templates[0];
}
export function getTheme(id: string) {
  const templates = loadThemeTemplates();
  return templates.find((t) => t.theme_id === id) ?? templates[0];
}
