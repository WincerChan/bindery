import { isRedirect, useRouter } from "@tanstack/solid-router";
import { createSignal } from "solid-js";
import { showToast } from "../client/toast";

export function useMutation() {
  const router = useRouter({ warn: false });
  const [busy, setBusy] = createSignal(false);
  async function run<T>(action: () => Promise<T>, success: (result: T) => Promise<void> | void, message?: string, dialog = false) {
    if (busy()) return;
    setBusy(true);
    try {
      const result = await action();
      if (message) showToast(message);
      await success(result);
      return result;
    } catch (error) {
      if (isRedirect(error)) { await router.navigate({ href: error.options.href || "/login" }); return; }
      if (dialog) throw error; // ConfirmDialog reports failures and stays open.
      showToast(error instanceof Error ? error.message : "操作失败，请重试", "error");
    } finally { setBusy(false); }
  }
  return { busy, run, router };
}
export function formFields(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries([...new FormData(form)].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
