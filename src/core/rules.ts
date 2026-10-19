import { buildRules, DEFAULT_RULE_CONFIG } from "./parsing";
import type { RuleConfig, RuleSet } from "./parsing";
import { strip } from "./python";
export interface RuleTemplate {
  rule_id: string;
  name: string;
  description: string | null;
  version: string;
  file_path: string;
  rules: RuleSet;
}
export class RuleTemplateError extends Error {}
export function validateRuleId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id))
    throw new RuleTemplateError(
      "模板 ID 不合法：仅支持字母/数字/-/_，且需以字母或数字开头",
    );
}
export function validateRuleTemplateJson(
  id: string,
  raw: string,
): Record<string, unknown> {
  validateRuleId(id);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new RuleTemplateError(`JSON 解析失败：${String(error)}`);
  }
  if (!data || Array.isArray(data) || typeof data !== "object")
    throw new RuleTemplateError("JSON 顶层必须是对象 (object)");
  if (data.id && strip(String(data.id)) && strip(String(data.id)) !== id)
    throw new RuleTemplateError(
      "JSON 内的 id 必须与当前模板 ID 一致（暂不支持重命名）",
    );
  const name = strip(String(data.name || id)) || id;
  const config: RuleConfig = { ...DEFAULT_RULE_CONFIG, rule_id: id, name };
  for (const key of [
    "chapter_patterns",
    "volume_patterns",
    "special_headings",
  ] as const) {
    const list = data[key] ?? DEFAULT_RULE_CONFIG[key];
    if (!Array.isArray(list) || !list.every((p) => typeof p === "string"))
      throw new RuleTemplateError(`${key} 必须是字符串数组`);
    config[key] = [...list];
  }
  for (const key of ["heading_max_len", "heading_max_commas"] as const) {
    const value = data[key] || DEFAULT_RULE_CONFIG[key];
    if (
      (typeof value !== "number" &&
        typeof value !== "boolean" &&
        (typeof value !== "string" || !/^[+-]?\d+$/.test(strip(value)))) ||
      !Number.isFinite(Number(value))
    )
      throw new RuleTemplateError(
        "heading_max_len / heading_max_commas 必须是整数",
      );
    config[key] = Math.trunc(Number(value));
    if (config[key] < 0) throw new RuleTemplateError(`${key} 不能小于 0`);
  }
  config.skip_candidate_re = String(
    data.skip_candidate_re || DEFAULT_RULE_CONFIG.skip_candidate_re,
  );
  try {
    buildRules(config);
  } catch (error) {
    throw new RuleTemplateError(`正则编译失败：${String(error)}`);
  }
  const { rule_id: _, ...fields } = config;
  const { description: _description, ...rest } = data;
  return {
    ...rest,
    ...fields,
    id,
    version: strip(String(data.version || "1")) || "1",
    ...(data.description != null
      ? { description: String(data.description) }
      : {}),
  };
}
// Loading deliberately uses Python's `or` defaults; validation preserves explicit empty arrays.
export function ruleTemplateFromData(
  data: Record<string, unknown>,
  filePath: string,
): RuleTemplate {
  const stem = filePath
    .split("/")
    .at(-1)!
    .replace(/\.json$/, "");
  const id = String(data.id || stem),
    name = String(data.name || id);
  const list = (
    key: "chapter_patterns" | "volume_patterns" | "special_headings",
  ) =>
    Array.isArray(data[key]) && data[key].length
      ? (data[key] as string[])
      : DEFAULT_RULE_CONFIG[key];
  return {
    rule_id: id,
    name,
    description: data.description == null ? null : String(data.description),
    version: String(data.version || "1"),
    file_path: filePath,
    rules: buildRules({
      rule_id: id,
      name,
      chapter_patterns: list("chapter_patterns"),
      volume_patterns: list("volume_patterns"),
      special_headings: list("special_headings"),
      heading_max_len: Number(data.heading_max_len || 40),
      heading_max_commas: Number(data.heading_max_commas || 1),
      skip_candidate_re: String(
        data.skip_candidate_re || DEFAULT_RULE_CONFIG.skip_candidate_re,
      ),
    }),
  };
}
