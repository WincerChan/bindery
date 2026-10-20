// Runtime validators are shared with tests; never trust TypeScript RPC types.
export function fieldsInput(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("表单格式错误");
  const entries = Object.entries(value);
  if (entries.some(([, value]) => typeof value !== "string")) throw new Error("表单格式错误");
  return Object.fromEntries(entries) as Record<string, string>;
}
export function entityId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new Error("条目 ID 格式错误");
  return value;
}
export function templateId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]+$/.test(value)) throw new Error("模板 ID 格式错误");
  return value;
}
export function templateKind(value: unknown): "rules" | "themes" {
  if (value !== "rules" && value !== "themes") throw new Error("模板类型错误");
  return value;
}
export function bookFormInput(value: unknown): FormData {
  if (!(value instanceof FormData)) throw new Error("表单格式错误");
  entityId(value.get("book_id"));
  let size = 0;
  for (const [, item] of value) size += typeof item === "string" ? new TextEncoder().encode(item).length : item.size;
  if (size > 22 * 1024 * 1024) throw new Error("表单内容过大");
  return value;
}
