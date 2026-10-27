import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../functions";

export const loadSettingsSummary = createServerFn({ method: "GET" }).middleware([authenticated])
  .handler(async ({ context }) => (await import("./summary")).settingsSummary(context.library));
