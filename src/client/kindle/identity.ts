import { KINDLE_MODELS, type KindleModel } from "../devices/models";
import { readKindleFirmware, pairDetectedDevice, type DeviceDetection } from "../devices/identity";
import type { DeviceDirectory } from "../devices/fs";
import { validateKindle as validateKindleRoot } from "../devices/identity";
export { KINDLE_MODELS, KOBO_MODELS } from "../devices/models";
export type { KindleModel } from "../devices/models";
export type { DeviceIdentity, PairedDevice } from "../devices/identity";
export { assertDevice, detectDevice, parseIdentity, readIdentity, readKoboVersion, validateDeviceRoot, validateKobo } from "../devices/identity";
export const validateKindle = (root: DeviceDirectory) => validateKindleRoot(root);
export async function readFirmware(root: DeviceDirectory): Promise<string | null> { return readKindleFirmware(root); }
export async function pairDevice(root: DeviceDirectory, model: KindleModel, name: string): Promise<import("../devices/identity").PairedDevice> {
  const detection: DeviceDetection = { kind: "kindle", model, modelCode: null, productUuid: null, firmware: await readKindleFirmware(root) };
  return pairDetectedDevice(root, detection, model, name);
}
