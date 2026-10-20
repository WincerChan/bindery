import { EntryAccessError, entryOperation, isMissing, optionalEntry, readBytes, readInternalJson, writeBytes, type KindleDirectory } from "./fs";

// KPW3, firmware 5.16.2.1.1, 霞鹜文楷 轻便版 Medium, Kindle size 7.
// Fits 16/14/11 CJK glyphs at narrow/medium/wide, and 18 at narrow with -0.8em or -4.8%.
// Vertical (narrow, widest Kindle line spacing, CSS-free paragraph): 13 lines per page, line pitch
// 96px = 1.75em; a mid-paragraph page starts its first line box 52px below the screen top (a chapter
// page 1em lower, from the paragraph's margin). The bottom is only bounded by those pages (48–92px);
// 70px sits mid-range and mirrors the header/footer bands. Medium/wide vertical margins are unmeasured.
// KO3 and unknown models use the same ratios as explicitly unmeasured estimates.
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
export interface DeviceIdentity { id: string; model: KindleModel; name: string; created_at: string }
export interface PairedDevice { root: KindleDirectory; identity: DeviceIdentity; firmware: string | null }
export function parseIdentity(value: unknown): DeviceIdentity {
  const v = value as DeviceIdentity | null;
  if (!v || typeof v.id !== "string" || !/^[\w-]{1,128}$/.test(v.id) || !Object.hasOwn(KINDLE_MODELS, v.model) || typeof v.name !== "string" || !v.name.trim() || v.name.length > 100 || typeof v.created_at !== "string" || !Number.isFinite(Date.parse(v.created_at))) throw new Error("Kindle 的 .bindery/device.json 损坏，请检查设备身份文件");
  return { id: v.id, model: v.model, name: v.name, created_at: v.created_at };
}
export async function validateKindle(root: KindleDirectory) {
  try { await root.getDirectoryHandle("documents"); await root.getDirectoryHandle("system"); }
  catch (error) { if (isMissing(error) || error instanceof Error && error.name === "TypeMismatchError") throw new Error("请选择 Kindle 磁盘根目录（必须包含 documents 和 system 文件夹）"); throw error; }
}
export async function readIdentity(root: KindleDirectory): Promise<DeviceIdentity | null> {
  const value = await readInternalJson(root, "device.json");
  return value === undefined ? null : parseIdentity(value);
}
export async function readFirmware(root: KindleDirectory): Promise<string | null> {
  try {
    const system = await entryOperation(root, "system", () => root.getDirectoryHandle("system"));
    if (!await optionalEntry(root, system, "version.txt", "system")) return null;
    return await entryOperation(root, "system/version.txt", async () => new TextDecoder().decode(await readBytes(system, "version.txt")).replace(/\0/g, "").trim() || null);
  } catch (error) { if (error instanceof EntryAccessError) return null; throw error; }
}
export async function pairDevice(root: KindleDirectory, model: KindleModel, name: string): Promise<PairedDevice> {
  await validateKindle(root);
  let identity = await readIdentity(root);
  if (!identity) {
    identity = parseIdentity({ id: crypto.randomUUID(), model, name: name.trim(), created_at: new Date().toISOString() });
    await entryOperation(root, ".bindery/device.json", async () => writeBytes(await root.getDirectoryHandle(".bindery", { create: true }), "device.json", JSON.stringify(identity, null, 2)));
  }
  return { root, identity, firmware: await readFirmware(root) };
}
export async function assertDevice(device: PairedDevice) {
  const identity = await readIdentity(device.root);
  if (identity?.id !== device.identity.id) throw new Error("Kindle 身份已改变，请重新连接设备");
}
