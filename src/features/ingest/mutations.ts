import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../../server/functions";
import { entityId } from "../../shared/mutation-input";

export const retryJob = createServerFn({ method: "POST" }).middleware([authenticated])
  .inputValidator(entityId).handler(async ({ context, data }) => {
    (await import("../../server/ingest/actions")).regenerateBook(context.library, "", new FormData(), data);
    return { retried: true };
  });
export const cleanupInvalidJobs = createServerFn({ method: "POST" }).middleware([authenticated])
  .inputValidator((tab: string) => {
    if (!["all", "running", "success", "failed"].includes(tab)) throw new Error("任务分组错误");
    return tab;
  }).handler(async ({ context, data }) => {
    (await import("../../server/ingest/actions")).cleanupInvalid(context.library, data);
    return { cleaned: true };
  });
