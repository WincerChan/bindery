import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryStorage } from "../src/server/storage";
import { BinderyDatabase } from "../src/server/db";
import { metadataFromDict } from "../src/core/models";
import { effectiveThemeId } from "../src/server/book-view";
import { loadRuleTemplates, loadThemeTemplates, templateDirectory } from "../src/server/templates";
import { catalogPage, deleteTemplate, newTemplate, ruleEditor, saveRule, saveTheme, testRule, themeEditor } from "../src/server/catalog/templates";
import { validateThemeCss } from "../src/server/catalog/theme-css";

let root: string, library: LibraryStorage;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bindery-catalog-template-"));
  for (const name of ["BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_TEMPLATE_DIR"]) { vi.stubEnv(name, ""); vi.stubEnv(`${name}_FILE`, ""); }
  vi.stubEnv("BINDERY_TEMPLATE_DIR", join(root, "templates"));
  library = new LibraryStorage(join(root, "library"), new BinderyDatabase(join(root, "data.db"))); library.ensure();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("rule and theme template behavior", () => {
  it("seeds defaults in the configured parent and honors individual and FILE overrides", () => {
    expect(templateDirectory("rules")).toBe(join(root, "templates", "rules"));
    expect(templateDirectory("themes")).toBe(join(root, "templates", "themes"));
    expect(loadRuleTemplates().some(r => r.rule_id === "default")).toBe(true);
    expect(loadThemeTemplates().some(t => t.theme_id === "default")).toBe(true);
    vi.stubEnv("BINDERY_RULES_DIR", join(root, "custom")); expect(templateDirectory("rules")).toBe(join(root, "custom"));
    vi.stubEnv("BINDERY_RULES_DIR", ""); writeFileSync(join(root, "path"), join(root, "from-file")); vi.stubEnv("BINDERY_RULES_DIR_FILE", join(root, "path"));
    expect(templateDirectory("rules")).toBe(join(root, "from-file"));
  });
  it("normalizes selected tabs and falls back to the first sorted template", () => {
    expect(catalogPage({ tab: "bad", rule_id: "absent" })).toMatchObject({ tab: "parsing", ruleId: "default", themeId: "default" });
    const target = new URL(newTemplate("rules"), "http://test"), id = target.searchParams.get("rule_id")!;
    expect(id).toMatch(/^custom-[a-f0-9]{8}$/);
    expect(catalogPage({ rule_id: "missing" }).ruleId).toBe(id);
    expect(ruleEditor(id)).toMatchObject({ name: "新规则", saved: false });
  });
  it("creates a rule from the validated default, retaining extra fields", () => {
    saveRule("default", JSON.stringify({ name: "基础", extra: { retained: true }, chapter_patterns: ["^A$"], volume_patterns: [], special_headings: [] }));
    const id = new URL(newTemplate("rules"), "http://test").searchParams.get("rule_id")!;
    expect(JSON.parse(ruleEditor(id).raw)).toMatchObject({ id, name: "新规则", description: "自定义切章规则", extra: { retained: true }, chapter_patterns: ["^A$"] });
  });
  it("recovers new-rule creation from an invalid default JSON", () => {
    writeFileSync(join(templateDirectory("rules"), "default.json"), "{bad");
    const id = new URL(newTemplate("rules"), "http://test").searchParams.get("rule_id")!;
    expect(ruleEditor(id).name).toBe("新规则");
  });
  it("renders an empty-template state when malformed JSON is the only existing template", () => {
    loadRuleTemplates(); writeFileSync(join(templateDirectory("rules"), "default.json"), "{bad");
    expect(catalogPage({})).toMatchObject({ rules: [], editor: null });
    loadThemeTemplates(); writeFileSync(join(templateDirectory("themes"), "default.json"), "{bad");
    expect(catalogPage({ tab: "themes" })).toMatchObject({ themes: [], editor: null });
  });
  it.each(["{bad", "[]", '{"id":"other"}', '{"chapter_patterns":[1]}', '{"volume_patterns":true}', '{"heading_max_len":-1}', '{"heading_max_commas":"bad"}', '{"chapter_patterns":["("]}', '{"skip_candidate_re":"(?>a+)"}'])("keeps invalid rule input and never writes it: %s", raw => {
    const before = ruleEditor("default").raw, result = saveRule("default", raw);
    expect(result).toMatchObject({ raw, saved: false }); expect(result.error).toBeTruthy(); expect(ruleEditor("default").raw).toBe(before);
  });
  it("normalizes rule fields with the existing core validator", () => {
    const result = saveRule("default", '{"name":"Name","chapter_patterns":["^A$"],"volume_patterns":[],"special_headings":[],"heading_max_len":"40","heading_max_commas":"1","skip_candidate_re":"x"}');
    expect(result.saved).toBe(true); expect(result.error).toBeNull();
    expect(JSON.parse(result.raw)).toMatchObject({ id: "default", version: "1", heading_max_len: 40, heading_max_commas: 1, chapter_patterns: ["^A$"], volume_patterns: [] });
  });
  it("tests saved rules, blank text, fallback templates, volumes and the 15-item TOC limit", () => {
    expect(testRule(" \n")).toBeNull();
    expect(testRule("第一章 起始\n内容\n", "missing")).toMatchObject({ chapters: 1 });
    const sample = "第一卷 开始\n" + Array.from({ length: 20 }, (_, i) => `第${i + 1}章 章节\n正文\n`).join("");
    expect(testRule(sample)).toMatchObject({ volumes: 1, chapters: 20 }); expect(testRule(sample)?.toc).toHaveLength(15);
  });
  it("clones theme CSS and preserves theme metadata and verbatim CSS on disk", () => {
    saveTheme("default", "p { color: red; }\n\n");
    const id = new URL(newTemplate("themes"), "http://test").searchParams.get("theme_id")!;
    expect(id).toMatch(/^theme-[a-f0-9]{8}$/); expect(themeEditor(id).raw).toBe("p { color: red; }");
    const raw = "p { color: blue; }\n\n", result = saveTheme(id, raw);
    expect(result.saved).toBe(true); expect(JSON.parse(readFileSync(join(templateDirectory("themes"), `${id}.json`), "utf8"))).toMatchObject({ id, name: "新样式", css: raw });
  });
  it.each(["rules", "themes"] as const)("protects default, missing, active and archived references for %s", kind => {
    expect(() => deleteTemplate(kind, "default", library)).toThrow("默认模板不可删除");
    expect(() => deleteTemplate(kind, "absent", library)).toThrow(kind === "rules" ? "规则不存在" : "主题不存在");
    const id = new URL(newTemplate(kind), "http://test").searchParams.get(kind === "rules" ? "rule_id" : "theme_id")!;
    const path = join(templateDirectory(kind), `${id}.json`), meta = metadataFromDict({ book_id: "a".repeat(32), title: "引用", [kind === "rules" ? "rule_template" : "theme_template"]: id });
    library.saveMetadata(meta);
    expect(deleteTemplate(kind, id, library)).toContain("&error="); expect(existsSync(path)).toBe(true);
    library.archiveBook(meta.book_id); expect(deleteTemplate(kind, id, library)).toContain("&error=");
    library.deleteBook(meta.book_id); expect(deleteTemplate(kind, id, library)).not.toContain("error"); expect(existsSync(path)).toBe(false);
  });
  it("rejects unknown IDs without falling back for the editors", () => {
    expect(() => ruleEditor("../default")).toThrow("规则不存在"); expect(() => themeEditor("missing")).toThrow("主题不存在");
  });
  it("uses global theme defaults and the EPUB keep-book-style sentinel", () => {
    expect(effectiveThemeId(metadataFromDict({ source_type: "epub" }))).toBe("default");
    expect(effectiveThemeId(metadataFromDict({ source_type: "epub", theme_template: "__book__" }))).toBeNull();
    expect(effectiveThemeId(metadataFromDict({ source_type: "txt", theme_template: "__book__" }))).toBe("__book__");
  });
});
describe("theme CSS validation", () => {
  it.each(["", "   ", "body { color: red; }", 'p{content:"}/*\\\""}', "/* { */ @media print { p { color:red } }"])("accepts %s", css => expect(validateThemeCss(css)).toBeNull());
  it.each([["body {", "CSS 花括号不匹配"], ["}body{}", "CSS 花括号不匹配"], ['p{content:"x}', "CSS 字符串未闭合"], ["/* nope", "CSS 注释未闭合"], ["p{\0}", "CSS 包含非法字符"], ["a".repeat(200_001), "CSS 过长（超过 200000 字符）"]])("rejects invalid CSS without touching the file", (css, error) => {
    expect(validateThemeCss(css)).toBe(error);
    const before = themeEditor("default").raw, result = saveTheme("default", css);
    expect(result).toMatchObject({ raw: css, saved: false, error: `主题 CSS 校验失败：${error}` }); expect(themeEditor("default").raw).toBe(before);
  });
  it("counts Unicode code points like legacy, rather than UTF-16 units", () => expect(validateThemeCss("😀".repeat(100_001))).toBeNull());
});
