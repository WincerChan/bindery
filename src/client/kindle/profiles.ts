/** Phase-1 compatibility adapter for the old Kindle-scoped UI; new code imports `client/devices/profiles`. */
import { validateCss } from "../../core/css";
import { KINDLE_MODELS, type KindleModel } from "./identity";
import { KINDLE_MARGIN_PRESETS, MARGIN_X_UNITS, MAXIMUM_MARGIN_X, minimumMarginX, type KindleMarginPreset, type MarginXUnit } from "./margins";
import {
  DEFAULT_PROFILE_ID, EMPTY_SETTINGS as NEW_EMPTY_SETTINGS, deviceIdInput as newDeviceIdInput,
  generateProfileCss as newGenerateProfileCss, profileInput as newProfileInput, profileKeyInput as newProfileKeyInput,
  profileSettings as newProfileSettings, type ProfileSettings as NewProfileSettings, type TypesettingProfile as NewTypesettingProfile,
} from "../devices/profiles";

export { DEFAULT_PROFILE_ID, MARGIN_X_UNITS, MAXIMUM_MARGIN_X, validateCss };
export type { MarginXUnit };
export interface ProfileSettings extends NewProfileSettings { deviceModel: KindleModel; kindleMargin: KindleMarginPreset }
export interface TypesettingProfile extends Omit<NewTypesettingProfile, "settings"> { deviceId: string; settings: ProfileSettings }
export const EMPTY_SETTINGS: ProfileSettings = Object.freeze({ ...NEW_EMPTY_SETTINGS, deviceModel: "KPW3", kindleMargin: "narrow" });
export const deviceIdInput = newDeviceIdInput;
export const defaultProfile = (deviceId: string): TypesettingProfile => ({ id: DEFAULT_PROFILE_ID, deviceId, name: "默认（只用书籍自带样式）", settings: { ...EMPTY_SETTINGS }, builtIn: true });

/** Keeps the old per-device margin bounds on top of the new global profile parser. */
export function profileSettings(value: unknown): ProfileSettings {
  if (!value || typeof value !== "object") throw new Error("无效的排版参数");
  const v = value as Record<string, unknown>;
  for (const [key, choices] of [["deviceModel", KINDLE_MODELS], ["kindleMargin", KINDLE_MARGIN_PRESETS]] as const) {
    if (v[key] !== undefined && (typeof v[key] !== "string" || !Object.hasOwn(choices, v[key]))) throw new Error(`无效的排版参数：${key}`);
  }
  const deviceModel = (v.deviceModel ?? EMPTY_SETTINGS.deviceModel) as KindleModel;
  const kindleMargin = (v.kindleMargin ?? EMPTY_SETTINGS.kindleMargin) as KindleMarginPreset;
  const output = newProfileSettings(value);
  if (output.marginX !== null) {
    const min = minimumMarginX(deviceModel, kindleMargin, output.marginXUnit), max = MAXIMUM_MARGIN_X[output.marginXUnit];
    if (output.marginX < min || output.marginX > max) {
      throw new Error(`左右边距调整（marginX）须在 ${min.toFixed(2)}–${max}${MARGIN_X_UNITS[output.marginXUnit]} 内，避免超出设备屏幕${output.marginXUnit === "em" ? "（按字号 7 校准）" : ""}`);
    }
  }
  return { ...output, deviceModel, kindleMargin };
}
const stripLegacy = (settings: ProfileSettings): NewProfileSettings => {
  const { deviceModel: _model, kindleMargin: _margin, ...rest } = settings;
  return rest;
};
export const generateProfileCss = (profile: TypesettingProfile) => newGenerateProfileCss({ id: profile.id, name: profile.name, builtIn: profile.builtIn, settings: stripLegacy(profile.settings) });
export function profileInput(value: unknown) {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.name !== "string" || !v.name.trim() || v.name.trim().length > 100) throw new Error("请输入 1–100 字的排版配置名称");
  const settings = profileSettings(v.settings), parsed = newProfileInput({ name: v.name, settings: stripLegacy(settings) });
  return { deviceId: newDeviceIdInput(v.deviceId), name: parsed.name, settings: { ...parsed.settings, deviceModel: settings.deviceModel, kindleMargin: settings.kindleMargin } };
}
export function profileKeyInput(value: unknown) {
  const v = value as Record<string, unknown> | null;
  return { deviceId: newDeviceIdInput(v?.deviceId), id: newProfileKeyInput(value).id };
}
