import { isMissing, readBytes, readJson, writeBytes, type KindleDirectory } from "./fs";

export const KINDLE_MODELS = {
  KPW3: { name: "Kindle Paperwhite 3", width: 1072, height: 1448, ppi: 300, inches: 6 },
  KO3: { name: "Kindle Oasis 3", width: 1264, height: 1680, ppi: 300, inches: 7 },
  other: { name: "其他 Kindle", width: null, height: null, ppi: null, inches: null },
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
  // Probe a known directory first: missing .bindery must not mask an unplugged drive.
  await root.getDirectoryHandle("documents");
  try { return parseIdentity(await readJson(await root.getDirectoryHandle(".bindery"), "device.json")); }
  catch (error) { if (isMissing(error)) { await root.getDirectoryHandle("documents"); return null; } throw error; }
}
export async function readFirmware(root: KindleDirectory): Promise<string | null> {
  const system = await root.getDirectoryHandle("system");
  try { return new TextDecoder().decode(await readBytes(system, "version.txt")).replace(/\0/g, "").trim() || null; }
  catch (error) { if (isMissing(error)) { await root.getDirectoryHandle("documents"); return null; } throw error; }
}
export async function pairDevice(root: KindleDirectory, model: KindleModel, name: string): Promise<PairedDevice> {
  await validateKindle(root);
  let identity = await readIdentity(root);
  if (!identity) {
    identity = parseIdentity({ id: crypto.randomUUID(), model, name: name.trim(), created_at: new Date().toISOString() });
    await writeBytes(await root.getDirectoryHandle(".bindery", { create: true }), "device.json", JSON.stringify(identity, null, 2));
  }
  return { root, identity, firmware: await readFirmware(root) };
}
export async function assertDevice(device: PairedDevice) {
  const identity = await readIdentity(device.root);
  if (identity?.id !== device.identity.id) throw new Error("Kindle 身份已改变，请重新连接设备");
}
