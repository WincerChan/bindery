import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../../server/functions";
import { libraryQueryInput, selectionInput } from "./search";

export const loadLibrary = createServerFn({ method: "GET" }).middleware([authenticated])
  .inputValidator(libraryQueryInput).handler(async ({ context, data }) =>
    (await import("../../server/library/queries")).loadLibraryPage(context.library, data));
export const loadArchive = createServerFn({ method: "GET" }).middleware([authenticated])
  .handler(async ({ context }) => (await import("../../server/library/queries")).archivePage(context.library));
export const restoreSelection = createServerFn({ method: "POST" }).middleware([authenticated])
  .inputValidator(selectionInput).handler(async ({ context, data }) =>
    (await import("../../server/library/actions")).restoreArchivedBooks(data, context.library));
export const regenerateSelection = createServerFn({ method: "POST" }).middleware([authenticated])
  .inputValidator(selectionInput).handler(async ({ context, data }) =>
    (await import("../../server/library/actions")).regenerateBooks(data, context.library));
