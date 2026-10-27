import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../../server/functions";
import { entityId, fieldsInput, templateId, templateKind } from "../../shared/mutation-input";

// Global function middleware in src/start.ts authenticates and supplies library.
export const saveTracker = createServerFn({ method: "POST" })
  .validator((data: { id?: string; fields: Record<string, string> }) => ({ id: data.id === undefined ? undefined : entityId(data.id), fields: fieldsInput(data.fields) }))
  .handler(async ({ context, data }) => ({ target: (await import("../../server/catalog/tracker")).writeTracker(context.library, data.fields, data.id) }));
export const deleteTracker = createServerFn({ method: "POST" }).middleware([authenticated])
  .validator((data: { id: string; next: string }) => ({ id: entityId(data.id), next: fieldsInput({ next: data.next }).next! }))
  .handler(async ({ context, data }) => ({ target: (await import("../../server/catalog/tracker")).removeTracker(context.library, data.id, data.next) }));
export const checkTracker = createServerFn({ method: "GET" }).middleware([authenticated])
  .validator((data: { title: string; author: string }) => fieldsInput(data))
  .handler(async ({ context, data }) => (await import("../../server/catalog/tracker")).duplicateCheck(context.library, data.title!, data.author!));
export const createTemplate = createServerFn({ method: "POST" }).middleware([authenticated])
  .validator(templateKind)
  .handler(async ({ data }) => ({ target: (await import("../../server/catalog/templates")).newTemplate(data) }));
export const removeTemplate = createServerFn({ method: "POST" }).middleware([authenticated])
  .validator((data: { kind: "rules" | "themes"; id: string }) => ({ kind: templateKind(data.kind), id: templateId(data.id) }))
  .handler(async ({ context, data }) => {
    const target = (await import("../../server/catalog/templates")).deleteTemplate(data.kind, data.id, context.library);
    const error = new URL(target, "http://local").searchParams.get("error");
    if (error) throw new Error(error);
    return { target };
  });
export const saveTemplate = createServerFn({ method: "POST" }).middleware([authenticated])
  .validator((data: { kind: "rules" | "themes"; id: string; raw: string; name?: string; operation?: "rename" | "copy" }) => ({ kind: templateKind(data.kind), id: templateId(data.id), raw: fieldsInput({ raw: data.raw }).raw!, name: fieldsInput({ name: data.name ?? "" }).name!, operation: data.operation === "rename" || data.operation === "copy" ? data.operation : undefined }))
  .handler(async ({ data }) => {
    const service = await import("../../server/catalog/templates");
    if (data.operation) return service.nameTemplate(data.kind, data.id, data.raw, data.name, data.operation);
    return { ...(data.kind === "rules" ? service.saveRule(data.id, data.raw) : service.saveTheme(data.id, data.raw)), target: undefined };
  });
export const testTemplate = createServerFn({ method: "POST" }).middleware([authenticated])
  .validator((data: { id: string; sample: string }) => ({ id: templateId(data.id), sample: fieldsInput({ sample: data.sample }).sample! }))
  .handler(async ({ data }) => (await import("../../server/catalog/templates")).testRule(data.sample, data.id));
export const rebuildTemplate = createServerFn({ method: "POST" }).middleware([authenticated])
  .validator((data: { kind: "rules" | "themes"; id: string }) => ({ kind: templateKind(data.kind), id: templateId(data.id) }))
  .handler(async ({ context, data }) => {
    // Keep the existing queue selection/capacity semantics without changing the
    // ingest task's files. Only a serializable outcome crosses the RPC boundary.
    const form = new FormData(); form.set("scope", data.kind === "themes" ? "themes" : "parsing"); form.set("template_id", data.id);
    const response = (await import("../../server/ingest/actions")).regenerateBulk(context.library, form);
    const target = response.headers.get("Location")!;
    const error = new URL(target, "http://local").searchParams.get("error");
    if (error) throw new Error(error);
    return { target };
  });
