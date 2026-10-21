import { strip } from "../../core/text";

// the legacy implementation's json.dumps(..., ensure_ascii=False) uses spaces after both separators.
export function compatJson(value: unknown, indent?: number): string {
  const json = JSON.stringify(value, null, indent);
  if (indent) return json;
  let result = "",
    inString = false,
    escaped = false;
  for (const char of json) {
    result += char;
    if (inString) {
      if (escaped) escaped = false;else if (char === "\\") escaped = true;else if (char === '"') inString = false;
    } else if (char === '"') inString = true;else if (char === "," || char === ":") result += " ";
  }
  return result;
}
export function compatString(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (Array.isArray(value)) return `[${value.map(compatRepr).join(", ")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([k, v]) => `${compatRepr(k)}: ${compatRepr(v)}`).join(", ")}}`;
  return String(value);
}
function compatRepr(value: unknown): string {
  if (typeof value !== "string") return compatString(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let result = quote;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\" || char === quote) result += `\\${char}`;else if (char === "\t") result += "\\t";else if (char === "\r") result += "\\r";else if (char === "\n") result += "\\n";else if (code !== 32 && /[\p{C}\p{Z}]/u.test(char)) {
      const [prefix, width] = code <= 255 ? ["x", 2] : code <= 65535 ? ["u", 4] : ["U", 8];
      result += `\\${prefix}${code.toString(16).padStart(width as number, "0")}`;
    } else result += char;
  }
  return result + quote;
}
export function readTags(raw: unknown): string[] {
  try {
    const tags: unknown = JSON.parse(typeof raw === "string" && raw ? raw : "[]");
    return Array.isArray(tags) ? tags.map(compatString).filter(tag => strip(tag)) : [];
  } catch {
    return [];
  }
}
export function wishIdentity(title: string | null, author: string | null): [string, string] {
  return [title, author].map(value => strip(value || "").toLowerCase().replace(/[^0-9a-zA-Z\u4e00-\u9fff]+/gu, "")) as [string, string];
}
// datetime.now(timezone.utc).isoformat(): six fractional digits, explicit offset.
export function nowIso(date = new Date()): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, (_, ms: string) => ms === "000" ? "+00:00" : `.${ms}000+00:00`);
}
export function awareTimestamp(value: unknown): number {
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  return Date.parse(value);
}
