import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../functions";
import { profileInput, profileKeyInput } from "../../client/devices/profiles";
import { deviceTypesetInput } from "./profiles";

const deviceKey = (value: unknown) => { const { deviceId, kind } = deviceTypesetInput(value); return { deviceId, kind }; };
export const listTypesetProfiles = createServerFn({ method: "GET" }).middleware([authenticated]).validator((value: unknown) => value)
  .handler(async ({ context }) => new (await import("./profiles")).TypesetProfiles(context.library.db).list());
export const createTypesetProfile = createServerFn({ method: "POST" }).middleware([authenticated]).validator(profileInput)
  .handler(async ({ context, data }) => new (await import("./profiles")).TypesetProfiles(context.library.db).create(data));
export const updateTypesetProfile = createServerFn({ method: "POST" }).middleware([authenticated]).validator((value: unknown) => ({ ...profileInput(value), ...profileKeyInput(value) }))
  .handler(async ({ context, data }) => new (await import("./profiles")).TypesetProfiles(context.library.db).update(data));
export const deleteTypesetProfile = createServerFn({ method: "POST" }).middleware([authenticated]).validator(profileKeyInput)
  .handler(async ({ context, data }) => new (await import("./profiles")).TypesetProfiles(context.library.db).delete(data));
export const getDeviceTypeset = createServerFn({ method: "GET" }).middleware([authenticated]).validator(deviceKey)
  .handler(async ({ context, data }) => new (await import("./profiles")).DeviceTypeset(context.library.db).get(data.deviceId, data.kind));
export const saveDeviceTypeset = createServerFn({ method: "POST" }).middleware([authenticated]).validator(deviceTypesetInput)
  .handler(async ({ context, data }) => new (await import("./profiles")).DeviceTypeset(context.library.db).save(data));
