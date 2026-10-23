import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../functions";
import { kindleReadingInput, koboReadingInput } from "./input";

export const syncKoboReading = createServerFn({ method: "POST" }).middleware([authenticated]).validator(koboReadingInput)
  .handler(async ({ context, data }) => (await import("./sync")).syncKoboReading(context.library, data));
export const syncKindleReading = createServerFn({ method: "POST" }).middleware([authenticated]).validator(kindleReadingInput)
  .handler(async ({ context, data }) => (await import("./sync")).syncKindleReading(context.library, data));
