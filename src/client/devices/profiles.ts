import { validateCss } from "../../core/css";
import { MARGIN_X_UNITS, MAXIMUM_MARGIN_X, type MarginXUnit } from "./typeset";

export interface ProfileSettings {
  marginX: number | null; marginXUnit: MarginXUnit; marginY: number | null; lineHeight: number | null;
  paragraphSpacing: number | null; textIndent: number | null; justify: boolean | null;
  fontFamily: string | null; customCss: string; stripFonts: boolean; stripImages: boolean; stripPageMargins: boolean;
}
export interface TypesettingProfile { id: string; name: string; settings: ProfileSettings; builtIn: boolean }
export const EMPTY_SETTINGS: ProfileSettings = Object.freeze({ marginX: null, marginXUnit: "percent", marginY: null, lineHeight: null, paragraphSpacing: null, textIndent: null, justify: null, fontFamily: null, customCss: "", stripFonts: false, stripImages: false, stripPageMargins: false });
export const DEFAULT_PROFILE_ID = "default";
export const defaultProfile = (): TypesettingProfile => ({ id: DEFAULT_PROFILE_ID, name: "默认（只用书籍自带样式）", settings: { ...EMPTY_SETTINGS }, builtIn: true });
export function deviceIdInput(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value)) throw new Error("无效的设备 ID");
  return value;
}
export function profileSettings(value: unknown): ProfileSettings {
  if (!value || typeof value !== "object") throw new Error("无效的排版参数");
  const v = value as Record<string, unknown>, output = { ...EMPTY_SETTINGS };
  // Older settings_json carries calibration metadata; keep accepting it, but it no longer affects CSS.
  for (const key of ["deviceModel", "kindleMargin"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") throw new Error(`无效的排版参数：${key}`);
  }
  if (v.marginXUnit !== undefined && (typeof v.marginXUnit !== "string" || !Object.hasOwn(MARGIN_X_UNITS, v.marginXUnit))) throw new Error("无效的排版参数：marginXUnit");
  // Settings saved before marginXUnit existed stored em; keep their output unchanged.
  output.marginXUnit = (v.marginXUnit ?? (typeof v.marginX === "number" ? "em" : EMPTY_SETTINGS.marginXUnit)) as MarginXUnit;
  for (const key of ["stripFonts", "stripImages", "stripPageMargins"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "boolean") throw new Error(`无效的排版参数：${key}`);
    output[key] = v[key] === true;
  }
  for (const key of ["marginX", "marginY", "lineHeight", "paragraphSpacing", "textIndent"] as const) {
    const n = v[key];
    const min = key === "marginX" ? -MAXIMUM_MARGIN_X[output.marginXUnit] : key === "lineHeight" ? 0.5 : 0;
    const max = key === "marginX" ? MAXIMUM_MARGIN_X[output.marginXUnit] : 20;
    if (n !== null && n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)) {
      if (key === "marginX") {
        const signed = (value: number) => value < 0 ? `−${Math.abs(value)}` : String(value);
        throw new Error(`左右边距调整（marginX）须在 ${signed(min)}–${signed(max)}${MARGIN_X_UNITS[output.marginXUnit]} 内`);
      }
      throw new Error(`无效的排版参数：${key}`);
    }
    output[key] = (n ?? null) as number | null;
  }
  if (v.justify !== undefined && v.justify !== null && typeof v.justify !== "boolean") throw new Error("无效的两端对齐设置");
  if (v.fontFamily !== undefined && v.fontFamily !== null && (typeof v.fontFamily !== "string" || !v.fontFamily.trim() || v.fontFamily.length > 200 || /[\x00-\x1f\x7f]/.test(v.fontFamily))) throw new Error("无效的字体名称");
  if (v.customCss !== undefined && typeof v.customCss !== "string") throw new Error("无效的自定义 CSS");
  const customCss = v.customCss ?? "", cssError = validateCss(customCss); if (cssError) throw new Error(cssError);
  output.justify = (v.justify ?? null) as boolean | null; output.fontFamily = (v.fontFamily ?? null) as string | null; output.customCss = customCss;
  return output;
}
/**
 * Fixed selector/property order; null means preserve the book. Custom CSS is last. Units are em except unitless line-height and the horizontal margin.
 * boko drops margins declared on `body` when building KFX (inherited properties such as line-height and font-family
 * still propagate), so horizontal margins target the top-level blocks instead. KFX has no CSS hook for per-page
 * top/bottom margins — those come from the device's own margin setting — so `marginY` is kept for stored profiles
 * but not emitted. Signed horizontal adjustments are relative to the device margin; percentages resolve against the
 * text column and so stay put when the font size changes, unlike legacy em values. The CSS is applied to both Kindle
 * and Kobo copies on transfer; device calibration metadata never generates CSS.
 */
export function generateProfileCss(profile: TypesettingProfile): string {
  if (profile.id === DEFAULT_PROFILE_ID) return "";
  const s = profileSettings(profile.settings), body: string[] = [], paragraph: string[] = [];
  const em = (n: number) => `${n}em`;
  if (s.marginX !== null) {
    const margin = `${s.marginX}${MARGIN_X_UNITS[s.marginXUnit]}`;
    body.push(`margin-left: ${margin} !important;`, `margin-right: ${margin} !important;`);
  }
  if (s.lineHeight !== null) paragraph.push(`line-height: ${s.lineHeight} !important;`);
  if (s.paragraphSpacing !== null) paragraph.push(`margin-top: 0 !important;`, `margin-bottom: ${em(s.paragraphSpacing)} !important;`);
  if (s.textIndent !== null) paragraph.push(`text-indent: ${em(s.textIndent)} !important;`);
  if (s.justify !== null) paragraph.push(`text-align: ${s.justify ? "justify" : "left"} !important;`);
  const font = s.fontFamily ? `body, body * {\n  font-family: "${s.fontFamily.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" !important;\n}` : "";
  return [body.length ? `body > * {\n  ${body.join("\n  ")}\n}` : "", paragraph.length ? `p {\n  ${paragraph.join("\n  ")}\n}` : "", font, s.customCss.trim()].filter(Boolean).join("\n\n");
}
export function profileInput(value: unknown) {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.name !== "string" || !v.name.trim() || v.name.trim().length > 100) throw new Error("请输入 1–100 字的排版配置名称");
  return { name: v.name.trim(), settings: profileSettings(v.settings) };
}
export function profileKeyInput(value: unknown) {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.id !== "string" || !/^[\w-]{1,128}$/.test(v.id)) throw new Error("无效的排版配置 ID");
  return { id: v.id };
}
