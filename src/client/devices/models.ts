export type DeviceKind = "kindle" | "kobo";

/** KPW3, firmware 5.16.2.1.1, 霞鹜文楷 轻便版 Medium, Kindle size 7. */
const calibration = (width: number, measured: boolean) => {
  const scale = (px: number) => Math.round(px * width / 1072);
  const sideMargins = { narrow: scale(80), medium: scale(137), wide: scale(220) };
  const vertical = (preset: keyof typeof sideMargins) => ({ top: scale(52), bottom: scale(70), measured: measured && preset === "narrow" });
  const verticalMargins = { narrow: vertical("narrow"), medium: vertical("medium"), wide: vertical("wide") };
  return { emPx: 55 * width / 1072, lineHeight: 1.75, sideMargins, measured, verticalMargins };
};
export const KINDLE_MODELS = {
  KPW3: { name: "Kindle Paperwhite 3", width: 1072, height: 1448, ppi: 300, inches: 6, typesetting: calibration(1072, true) },
  KO3: { name: "Kindle Oasis 3", width: 1264, height: 1680, ppi: 300, inches: 7, typesetting: calibration(1264, false) },
  other: { name: "其他 Kindle", width: null, height: null, ppi: null, inches: null, typesetting: calibration(1072, false) },
} as const;
export type KindleModel = keyof typeof KINDLE_MODELS;

export interface KoboModelInfo { name: string; width: number | null; height: number | null; ppi: number | null; inches: number | null }
export const KOBO_MODELS = {
  libra2: { name: "Kobo Libra 2", width: 1264, height: 1680, ppi: 300, inches: 7 },
  libraH2O: { name: "Kobo Libra H2O", width: 1264, height: 1680, ppi: 300, inches: 7 },
  sage: { name: "Kobo Sage", width: 1440, height: 1920, ppi: 300, inches: 8 },
  elipsa: { name: "Kobo Elipsa", width: 1404, height: 1872, ppi: 227, inches: 10.3 },
  claraHD: { name: "Kobo Clara HD", width: 1072, height: 1448, ppi: 300, inches: 6 },
  clara2e: { name: "Kobo Clara 2E", width: 1072, height: 1448, ppi: 300, inches: 6 },
  claraBW: { name: "Kobo Clara BW", width: 1072, height: 1448, ppi: 300, inches: 6 },
  claraColour: { name: "Kobo Clara Colour", width: 1072, height: 1448, ppi: 300, inches: 6 },
  libraColour: { name: "Kobo Libra Colour", width: 1264, height: 1680, ppi: 300, inches: 7 },
  nia: { name: "Kobo Nia", width: 758, height: 1024, ppi: 212, inches: 6 },
  forma: { name: "Kobo Forma", width: 1440, height: 1920, ppi: 300, inches: 8 },
  auraOne: { name: "Kobo Aura ONE", width: 1404, height: 1872, ppi: 300, inches: 7.8 },
  auraH2O: { name: "Kobo Aura H2O", width: 1080, height: 1430, ppi: 265, inches: 6.8 },
  auraEdition2: { name: "Kobo Aura Edition 2", width: 758, height: 1024, ppi: 212, inches: 6 },
  aura: { name: "Kobo Aura", width: 758, height: 1024, ppi: 212, inches: 6 },
  glo: { name: "Kobo Glo", width: 758, height: 1024, ppi: 212, inches: 6 },
  touch: { name: "Kobo Touch", width: 600, height: 800, ppi: 167, inches: 6 },
  mini: { name: "Kobo Mini", width: 600, height: 800, ppi: 167, inches: 5 },
  unknown: { name: "Kobo（未知型号）", width: null, height: null, ppi: null, inches: null },
} as const satisfies Record<string, KoboModelInfo>;
export type KoboModel = keyof typeof KOBO_MODELS;

/**
 * Product IDs from `.kobo/version` (last comma-separated field). Kobo reuses
 * model codes across revisions; every listed model still shares a family name
 * and screen class, which is all Bindery displays in phase one.
 */
export const KOBO_PRODUCT_MODELS: Record<string, KoboModel> = {
  N249: "claraHD",
  N306: "nia",
  N365: "claraBW",
  N367: "claraColour",
  N415: "sage",
  N418: "libra2",
  N428: "libraColour",
  N236: "auraEdition2",
  N437: "auraH2O",
  N506: "clara2e",
  N514: "aura",
  N604: "elipsa",
  N613: "glo",
  N705: "mini",
  N905: "touch",
  N709: "auraOne",
  N782: "forma",
  N873: "libraH2O",
  N250: "auraH2O",
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
