import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../../server/functions";
import { entityId } from "../../shared/mutation-input";

export const mutateLibrarySelection = createServerFn({ method: "POST" }).middleware([authenticated])
  .validator((data: { action: "archive" | "restore" | "delete"; ids: string[] }) => {
    if (!data || !["archive", "restore", "delete"].includes(data.action)) throw new Error("操作类型错误");
    if (!Array.isArray(data.ids) || !data.ids.length) throw new Error("未选择书籍");
    return { action: data.action, ids: [...new Set(data.ids.map(entityId))] };
  })
  .handler(async ({ context, data }) => {
    const service = await import("../../server/library/actions");
    return (data.action === "archive" ? service.archiveBooks : data.action === "restore" ? service.restoreArchivedBooks : service.deleteArchivedBooks)(data.ids, context.library);
  });
