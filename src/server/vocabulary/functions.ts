import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../functions";
import { vocabularyInput } from "./input";

export const syncVocabulary = createServerFn({ method: "POST" }).middleware([authenticated]).validator(vocabularyInput)
  .handler(async ({ context, data }) => {
    const result = (await import("./sync")).syncVocabulary(context.library, data);
    void (await import("./push")).kickVocabularyPush(context.library);
    return result;
  });

export const listVocabulary = createServerFn({ method: "GET" }).middleware([authenticated]).validator((value: unknown) => value)
  .handler(async ({ context, data }) => {
    const page = (await import("./query")).listVocabularyPage(context.library, data);
    void (await import("./push")).kickVocabularyPush(context.library);
    return page;
  });

export const getLexiTraceSettings = createServerFn({ method: "GET" }).middleware([authenticated]).validator((value: unknown) => value)
  .handler(async ({ context }) => (await import("./settings")).lexTraceSettingsView(context.library.db));

export const saveLexiTraceSettings = createServerFn({ method: "POST" }).middleware([authenticated]).validator((value: unknown) => value)
  .handler(async ({ context, data }) => {
    const result = (await import("./settings")).saveLexiTraceSettings(context.library.db, data);
    void (await import("./push")).kickVocabularyPush(context.library);
    return result;
  });

export const testLexiTraceConnection = createServerFn({ method: "POST" }).middleware([authenticated]).validator((value: unknown) => value)
  .handler(async ({ context, data }) => (await import("./settings")).testLexiTraceConnection(context.library.db, data));

export const retryVocabularyPush = createServerFn({ method: "POST" }).middleware([authenticated]).validator((value: unknown) => value)
  .handler(async ({ context, data }) => {
    const value = data !== null && typeof data === "object" && !Array.isArray(data) ? data as { ids?: unknown } : {};
    const ids = Array.isArray(value.ids) ? value.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) : undefined;
    const retried = (await import("./push")).retryVocabularyPush(context.library, ids);
    return { retried, page: (await import("./query")).listVocabularyPage(context.library) };
  });
