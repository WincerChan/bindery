import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../functions";
import { deviceIdInput, profileInput, profileKeyInput } from "../../client/kindle/profiles";

export const listKindleProfiles = createServerFn({ method: "GET" }).middleware([authenticated]).validator(deviceIdInput)
  .handler(async ({ context, data }) => new (await import("./profiles")).KindleProfiles(context.library.db).list(data));
export const createKindleProfile = createServerFn({ method: "POST" }).middleware([authenticated]).validator(profileInput)
  .handler(async ({ context, data }) => new (await import("./profiles")).KindleProfiles(context.library.db).create(data));
export const updateKindleProfile = createServerFn({ method: "POST" }).middleware([authenticated]).validator((value: unknown) => ({ ...profileInput(value), ...profileKeyInput(value) }))
  .handler(async ({ context, data }) => new (await import("./profiles")).KindleProfiles(context.library.db).update(data));
export const deleteKindleProfile = createServerFn({ method: "POST" }).middleware([authenticated]).validator(profileKeyInput)
  .handler(async ({ context, data }) => new (await import("./profiles")).KindleProfiles(context.library.db).delete(data));
