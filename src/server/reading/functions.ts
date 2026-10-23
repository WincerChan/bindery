import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../functions";
import { deviceIdInput } from "../../client/devices/profiles";
import { kindleReadingInput, koboReadingInput } from "./input";

export const syncKoboReading = createServerFn({ method: "POST" }).middleware([authenticated]).validator(koboReadingInput)
  .handler(async ({ context, data }) => (await import("./sync")).syncKoboReading(context.library, data));
export const getDeviceChapters = createServerFn({ method: "GET" }).middleware([authenticated]).validator(deviceIdInput)
  .handler(async ({ context, data }) => (await import("./chapters")).deviceChapters(context.library, data));
export const syncKindleReading = createServerFn({ method: "POST" }).middleware([authenticated]).validator(kindleReadingInput)
  .handler(async ({ context, data }) => (await import("./sync")).syncKindleReading(context.library, data));
