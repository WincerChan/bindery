import { validateCss } from "../../core/css";

export interface ProfileSettings {
  marginX: number | null; marginY: number | null; lineHeight: number | null;
  paragraphSpacing: number | null; textIndent: number | null; justify: boolean | null;
  fontFamily: string | null; customCss: string;
}
export interface TypesettingProfile { id: string; deviceId: string; name: string; settings: ProfileSettings; builtIn: boolean }
export const EMPTY_SETTINGS: ProfileSettings = Object.freeze({ marginX: null, marginY: null, lineHeight: null, paragraphSpacing: null, textIndent: null, justify: null, fontFamily: null, customCss: "" });
export const DEFAULT_PROFILE_ID = "default";
export const defaultProfile = (deviceId: string): TypesettingProfile => ({ id: DEFAULT_PROFILE_ID, deviceId, name: "默认（只用书籍自带样式）", settings: { ...EMPTY_SETTINGS }, builtIn: true });
export function deviceIdInput(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value)) throw new Error("无效的 Kindle 设备 ID");
  return value;
}
export function profileSettings(value: unknown): ProfileSettings {
  if (!value || typeof value !== "object") throw new Error("无效的排版参数");
  const v = value as Record<string, unknown>, output = { ...EMPTY_SETTINGS };
  for (const key of ["marginX", "marginY", "lineHeight", "paragraphSpacing", "textIndent"] as const) {
    const n = v[key];
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < (key === "lineHeight" ? 0.5 : 0) || n > 20)) throw new Error(`无效的排版参数：${key}`);
    output[key] = n as number | null;
  }
  if (v.justify !== null && typeof v.justify !== "boolean") throw new Error("无效的两端对齐设置");
  if (v.fontFamily !== null && (typeof v.fontFamily !== "string" || !v.fontFamily.trim() || v.fontFamily.length > 200 || /[\x00-\x1f\x7f]/.test(v.fontFamily))) throw new Error("无效的字体名称");
  if (typeof v.customCss !== "string") throw new Error("无效的自定义 CSS");
  const cssError = validateCss(v.customCss); if (cssError) throw new Error(cssError);
  output.justify = v.justify as boolean | null; output.fontFamily = v.fontFamily as string | null; output.customCss = v.customCss;
  return output;
}
/** Fixed selector/property order; null means preserve the book. Custom CSS is last. Units are em except unitless line-height. */
export function generateProfileCss(profile: TypesettingProfile): string {
  if (profile.id === DEFAULT_PROFILE_ID) return "";
  const s = profileSettings(profile.settings), body: string[] = [], paragraph: string[] = [];
  const em = (n: number) => `${n}em`;
  if (s.marginX !== null) body.push(`margin-left: ${em(s.marginX)} !important;`, `margin-right: ${em(s.marginX)} !important;`);
  if (s.marginY !== null) body.push(`margin-top: ${em(s.marginY)} !important;`, `margin-bottom: ${em(s.marginY)} !important;`);
  if (s.lineHeight !== null) paragraph.push(`line-height: ${s.lineHeight} !important;`);
  if (s.paragraphSpacing !== null) paragraph.push(`margin-top: 0 !important;`, `margin-bottom: ${em(s.paragraphSpacing)} !important;`);
  if (s.textIndent !== null) paragraph.push(`text-indent: ${em(s.textIndent)} !important;`);
  if (s.justify !== null) paragraph.push(`text-align: ${s.justify ? "justify" : "left"} !important;`);
  const font = s.fontFamily ? `body, body * {\n  font-family: "${s.fontFamily.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" !important;\n}` : "";
  return [body.length ? `body {\n  ${body.join("\n  ")}\n}` : "", paragraph.length ? `p {\n  ${paragraph.join("\n  ")}\n}` : "", font, s.customCss.trim()].filter(Boolean).join("\n\n");
}
export function profileInput(value: unknown) {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.name !== "string" || !v.name.trim() || v.name.trim().length > 100) throw new Error("请输入 1–100 字的排版配置名称");
  return { deviceId: deviceIdInput(v.deviceId), name: v.name.trim(), settings: profileSettings(v.settings) };
}
export function profileKeyInput(value: unknown) {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.id !== "string" || !/^[\w-]{1,128}$/.test(v.id)) throw new Error("无效的排版配置 ID");
  return { deviceId: deviceIdInput(v.deviceId), id: v.id };
}
