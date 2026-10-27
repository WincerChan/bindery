const languageNames: Record<string, string> = { zh: "中文", en: "英文", ja: "日文", ko: "韩文", fr: "法文", de: "德文", es: "西班牙文", ru: "俄文" };
/** BCP 47 tag → reader-facing name ("zh-CN" → "中文"); unknown tags stay as written. */
export function languageLabel(tag: string): string {
  return languageNames[tag.trim().toLowerCase().split(/[-_]/)[0] || ""] || tag;
}
