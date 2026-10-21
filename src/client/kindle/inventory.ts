import { inventory as genericInventory, deviceInventory as genericDeviceInventory, isBook } from "../devices/inventory";
import type { DeviceDirectory } from "../devices/fs";
import type { UnreadableEntry } from "../devices/fs";
export { isKoboBook, type DeviceBook, type DeviceBookRecord, type DeviceInventory } from "../devices/inventory";
export { isBook };
export const inventory = (root: DeviceDirectory, unreadable: UnreadableEntry[] = []) => genericInventory(root, "kindle", unreadable);
export const deviceInventory = genericDeviceInventory;
