import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../functions";
import { vocabularyInput } from "./input";

export const syncVocabulary = createServerFn({ method: "POST" }).middleware([authenticated]).validator(vocabularyInput)
  .handler(async ({ context, data }) => (await import("./sync")).syncVocabulary(context.library, data));
