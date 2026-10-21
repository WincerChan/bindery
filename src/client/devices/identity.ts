import { readInternalJson, writeBytes, entryOperation, isMissing, optionalEntry, readBytes, type DeviceDirectory } from "./fs";
import { KINDLE_MODELS, KOBO_MODELS, koboModelForProduct, type DeviceKind, type KoboModel, type KindleModel } from "./models";

export { KINDLE_MODELS, KOBO_MODELS };
export type { DeviceKind, KindleModel, KoboModel };

export interface DeviceIdentity { id: string; kind: DeviceKind; model: string; name: string; created_at: string; model_code?: string; product_id?: string }
export interface PairedDevice { root: DeviceDirectory; identity: DeviceIdentity; firmware: string | null }
export interface DeviceDetection { kind: DeviceKind; model: string; modelCode: string | null; productUuid: string | null; firmware: string | null }

export function parseIdentity(value: unknown): DeviceIdentity {
  const v = value as Partial<DeviceIdentity> | null;
  if (!v || typeof v.id !== "string" || !/^[\w-]{1,128}$/.test(v.id) || typeof v.name !== "string" || !v.name.trim() || v.name.length > 100 || typeof v.created_at !== "string" || !Number.isFinite(Date.parse(v.created_at))) throw new Error("设备的 .bindery/device.json 损坏，请检查设备身份文件");
  // Legacy Kindle identities have no kind field.
  const kind: DeviceKind = v.kind === "kobo" ? "kobo" : v.kind === "kindle" || v.kind === undefined ? "kindle" : (() => { throw new Error("设备的 .bindery/device.json 包含未知设备种类"); })();
  if (typeof v.model !== "string" || !v.model || v.model.length > 100) throw new Error("设备的 .bindery/device.json 包含无效型号");
  if (kind === "kindle" && !Object.hasOwn(KINDLE_MODELS, v.model)) throw new Error("Kindle 的 .bindery/device.json 包含无效型号");
  if (v.model_code !== undefined && (typeof v.model_code !== "string" || !/^[A-Za-z]\d{3}$/.test(v.model_code))) throw new Error("设备的 .bindery/device.json 包含无效型号代码");
  if (v.product_id !== undefined && (typeof v.product_id !== "string" || v.product_id.length > 100)) throw new Error("设备的 .bindery/device.json 包含无效产品 UUID");
  return { id: v.id, kind, model: v.model, name: v.name, created_at: v.created_at, ...(v.model_code ? { model_code: v.model_code.toUpperCase() } : {}), ...(v.product_id ? { product_id: v.product_id } : {}) };
}

export async function validateKindle(root: DeviceDirectory) {
  try { await root.getDirectoryHandle("documents"); await root.getDirectoryHandle("system"); }
  catch (error) { if (isMissing(error) || error instanceof Error && error.name === "TypeMismatchError") throw new Error("请选择 Kindle 磁盘根目录（必须包含 documents 和 system 文件夹）"); throw error; }
}
export async function validateKobo(root: DeviceDirectory) {
  try { await root.getDirectoryHandle(".kobo"); }
  catch (error) { if (isMissing(error) || error instanceof Error && error.name === "TypeMismatchError") throw new Error("请选择 Kobo 磁盘根目录（必须包含 .kobo 文件夹）"); throw error; }
}

export async function readIdentity(root: DeviceDirectory, kind: DeviceKind = "kindle"): Promise<DeviceIdentity | null> {
  const value = await readInternalJson(root, "device.json", kind);
  return value === undefined ? null : parseIdentity(value);
}
export async function readKindleFirmware(root: DeviceDirectory): Promise<string | null> {
  try {
    const system = await entryOperation(root, "system", () => root.getDirectoryHandle("system"));
    if (!await optionalEntry(root, system, "version.txt", "system")) return null;
    return await entryOperation(root, "system/version.txt", async () => new TextDecoder().decode(await readBytes(system, "version.txt")).replace(/\0/g, "").trim() || null);
  } catch (error) { if (error instanceof Error && error.name === "EntryAccessError") return null; throw error; }
}
/**
 * Real format (Kobo Libra 2):
 * `N418123456789,4.1.15,4.38.23171,4.1.15,4.1.15,00000000-0000-0000-0000-000000000388`
 * field 0 = serial (first four chars are the model code), field 2 = firmware,
 * last field = product UUID. Do not use the UUID for model identification.
 */
export interface KoboVersion { raw: string; fields: string[]; serial: string | null; modelCode: string | null; firmware: string | null; productUuid: string | null }
export function parseKoboVersion(raw: string): KoboVersion {
  const fields = raw.replace(/\0/g, "").trim().split(",").map(field => field.trim());
  const serial = fields[0] || null;
  const modelCode = serial && /^[A-Za-z]\d{3}/.test(serial) ? serial.slice(0, 4).toUpperCase() : null;
  const firmware = fields[2] || null;
  const productUuid = fields.length > 1 ? fields.at(-1) || null : null;
  return { raw, fields, serial, modelCode, firmware, productUuid };
}
export async function readKoboVersion(root: DeviceDirectory): Promise<KoboVersion | null> {
  try {
    const kobo = await entryOperation(root, ".kobo", () => root.getDirectoryHandle(".kobo"), "kobo");
    if (!await optionalEntry(root, kobo, "version", ".kobo", "kobo")) return null;
    return parseKoboVersion(await entryOperation(root, ".kobo/version", async () => new TextDecoder().decode(await readBytes(kobo, "version")), "kobo"));
  } catch (error) { if (error instanceof Error && error.name === "EntryAccessError") return null; throw error; }
}
export async function readFirmware(root: DeviceDirectory, kind: DeviceKind): Promise<string | null> {
  return kind === "kobo" ? (await readKoboVersion(root))?.firmware ?? null : readKindleFirmware(root);
}

/** Detect the device kind from its root sentinel before an identity is paired. */
export async function detectDevice(root: DeviceDirectory): Promise<DeviceDetection> {
  let kobo: DeviceDirectory | null = null;
  try { kobo = await root.getDirectoryHandle(".kobo"); }
  catch (error) {
    if (!isMissing(error) && !(error instanceof Error && error.name === "TypeMismatchError")) throw error;
  }
  if (kobo) {
    const version = await readKoboVersion(root);
    const modelCode = version?.modelCode ?? null;
    return { kind: "kobo", model: koboModelForProduct(modelCode), modelCode, productUuid: version?.productUuid ?? null, firmware: version?.firmware ?? null };
  }
  try { await root.getDirectoryHandle("documents"); await root.getDirectoryHandle("system"); }
  catch (error) {
    if (isMissing(error) || error instanceof Error && error.name === "TypeMismatchError") throw new Error("请选择 Kindle 磁盘根目录（documents 和 system）或 Kobo 磁盘根目录（.kobo）");
    throw error;
  }
  return { kind: "kindle", model: "KPW3", modelCode: null, productUuid: null, firmware: await readKindleFirmware(root) };
}
export async function validateDeviceRoot(root: DeviceDirectory): Promise<DeviceDetection> {
  return detectDevice(root);
}

export async function pairDetectedDevice(root: DeviceDirectory, detection: DeviceDetection, model: string, name: string): Promise<PairedDevice> {
  if (detection.kind === "kindle") await validateKindle(root); else await validateKobo(root);
  let identity = await readIdentity(root, detection.kind);
  if (identity && identity.kind !== detection.kind) throw new Error("设备身份与设备种类不一致，请检查 .bindery/device.json");
  if (!identity) {
    const selected = detection.kind === "kobo" ? (Object.hasOwn(KOBO_MODELS, model) ? model : detection.model) : model;
    identity = parseIdentity({ id: crypto.randomUUID(), kind: detection.kind, model: selected, name: name.trim(), created_at: new Date().toISOString(), ...(detection.modelCode ? { model_code: detection.modelCode } : {}), ...(detection.productUuid ? { product_id: detection.productUuid } : {}) });
    await entryOperation(root, ".bindery/device.json", async () => writeBytes(await root.getDirectoryHandle(".bindery", { create: true }), "device.json", JSON.stringify(identity, null, 2)), detection.kind);
  }
  return { root, identity, firmware: await readFirmware(root, identity.kind) };
}
export async function assertDevice(device: PairedDevice) {
  const identity = await readIdentity(device.root, device.identity.kind);
  if (identity?.id !== device.identity.id || identity.kind !== device.identity.kind) throw new Error("设备身份已改变，请重新连接设备");
}
