import { SCREEN_PANELS, type ScreenPanelId } from "./panels";

export type DeviceKind = "kindle" | "kobo";

/** Measured at 300 ppi, then scaled by the panel's pixel density. */
const calibration = (ppi: number, measured: boolean) => {
  const scale = (px: number) => Math.round(px * ppi / 300);
  const sideMargins = { narrow: scale(80), medium: scale(137), wide: scale(220) };
  const vertical = (preset: keyof typeof sideMargins) => ({ top: scale(52), bottom: scale(70), measured: measured && preset === "narrow" });
  const verticalMargins = { narrow: vertical("narrow"), medium: vertical("medium"), wide: vertical("wide") };
  return { emPx: 55 * ppi / 300, lineHeight: 1.75, sideMargins, measured, verticalMargins };
};
const kindleModel = (name: string, panel: ScreenPanelId, measured = false, inches?: number) => {
  const screen = SCREEN_PANELS[panel];
  return { name, width: screen.width, height: screen.height, ppi: screen.ppi, inches: inches ?? screen.inches, panel, typesetting: calibration(screen.ppi, measured) };
};
export const KINDLE_MODELS = {
  KPW3: kindleModel("Kindle Paperwhite 3", "1072x1448", true),
  KO3: kindleModel("Kindle Oasis 3", "1264x1680"),
  other: { name: "其他 Kindle", width: null, height: null, ppi: null, inches: null, panel: null, typesetting: calibration(300, false) },
} as const;
export type KindleModel = keyof typeof KINDLE_MODELS;

export interface KoboModelInfo { name: string; width: number | null; height: number | null; ppi: number | null; inches: number | null; panel: ScreenPanelId | null }
const koboModel = (name: string, panel: ScreenPanelId, inches?: number): KoboModelInfo => {
  const screen = SCREEN_PANELS[panel];
  return { name, width: screen.width, height: screen.height, ppi: screen.ppi, inches: inches ?? screen.inches, panel };
};
export const KOBO_MODELS = {
  libra2: koboModel("Kobo Libra 2", "1264x1680"),
  libraH2O: koboModel("Kobo Libra H2O", "1264x1680"),
  sage: koboModel("Kobo Sage", "1440x1920"),
  elipsa: koboModel("Kobo Elipsa", "1404x1872@227"),
  claraHD: koboModel("Kobo Clara HD", "1072x1448"),
  clara2e: koboModel("Kobo Clara 2E", "1072x1448"),
  claraBW: koboModel("Kobo Clara BW", "1072x1448"),
  claraColour: koboModel("Kobo Clara Colour", "1072x1448"),
  libraColour: koboModel("Kobo Libra Colour", "1264x1680"),
  nia: koboModel("Kobo Nia", "758x1024"),
  forma: koboModel("Kobo Forma", "1440x1920"),
  auraOne: koboModel("Kobo Aura ONE", "1404x1872@300"),
  auraH2O: koboModel("Kobo Aura H2O", "1080x1430"),
  auraEdition2: koboModel("Kobo Aura Edition 2", "758x1024"),
  aura: koboModel("Kobo Aura", "758x1024"),
  glo: koboModel("Kobo Glo", "758x1024"),
  touch: koboModel("Kobo Touch", "600x800"),
  mini: koboModel("Kobo Mini", "600x800", 5),
  unknown: { name: "Kobo（未知型号）", width: null, height: null, ppi: null, inches: null, panel: null },
} as const satisfies Record<string, KoboModelInfo>;
export type KoboModel = keyof typeof KOBO_MODELS;

/**
 * Model codes are the first four characters of the serial in `.kobo/version`.
 * N418/Libra 2 is pending verification against the user's real device file;
 * all other entries are unverified community mappings and only affect the
 * displayed name. Unknown codes remain fully usable as "Kobo（未知型号）".
 */
export const KOBO_PRODUCT_MODELS: Record<string, KoboModel> = {
  N249: "claraHD", // 未核实（社区映射）
  N306: "nia", // 未核实（社区映射）
  N365: "claraBW", // 未核实（社区映射）
  N367: "claraColour", // 未核实（社区映射）
  N415: "sage", // 未核实（社区映射）
  N418: "libra2", // Libra 2（待用户真机 `.kobo/version` 复核）
  N428: "libraColour", // 未核实（社区映射）
  N236: "auraEdition2", // 未核实（社区映射）
  N437: "auraH2O", // 未核实（社区映射）
  N506: "clara2e", // 未核实（社区映射）
  N514: "aura", // 未核实（社区映射）
  N604: "elipsa", // 未核实（社区映射）
  N613: "glo", // 未核实（社区映射）
  N705: "mini", // 未核实（社区映射）
  N905: "touch", // 未核实（社区映射）
  N709: "auraOne", // 未核实（社区映射）
  N782: "forma", // 未核实（社区映射）
  N873: "libraH2O", // 未核实（社区映射）
  N250: "auraH2O", // 未核实（社区映射）
};

export function koboModelForProduct(product: string | null | undefined): KoboModel {
  if (!product) return "unknown";
  const key = product.trim().toUpperCase();
  return KOBO_PRODUCT_MODELS[key] ?? "unknown";
}
export function kindleModelInfo(model: string): (typeof KINDLE_MODELS)[KindleModel] {
  return Object.hasOwn(KINDLE_MODELS, model) ? KINDLE_MODELS[model as KindleModel] : KINDLE_MODELS.other;
}
export function koboModelInfo(model: string): KoboModelInfo {
  return Object.hasOwn(KOBO_MODELS, model) ? KOBO_MODELS[model as KoboModel] : KOBO_MODELS.unknown;
}
export const deviceKindLabel = (kind: DeviceKind) => kind === "kindle" ? "Kindle" : "Kobo";
export function modelLabel(kind: DeviceKind, model: string): string {
  const info = kind === "kindle" ? kindleModelInfo(model) : koboModelInfo(model);
  return `${info.name}${info.width ? ` · ${info.width}×${info.height} · ${info.ppi} ppi · ${info.inches}″` : ""}`;
}
export const modelShortName = (kind: DeviceKind, model: string) => (kind === "kindle" ? kindleModelInfo(model) : koboModelInfo(model)).name;
