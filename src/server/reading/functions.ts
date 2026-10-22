import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../functions";
import { koboReadingInput } from "./input";

export const syncKoboReading = createServerFn({ method: "POST" }).middleware([authenticated]).validator(koboReadingInput)
  .handler(async ({ context, data }) => (await import("./sync")).syncKoboReading(context.library, data));
