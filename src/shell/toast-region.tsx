import TablerAlertTriangle from "~icons/tabler/alert-triangle";
import TablerCircleCheck from "~icons/tabler/circle-check";
import TablerCircleX from "~icons/tabler/circle-x";
import { useRouter } from "@tanstack/solid-router";
import { createSignal, onSettled } from "solid-js";
import { installToastBridge } from "../client/toast";
import { flashFromUrl, type ToastMessage } from "../shared/notifications";
import { CloseButton, Icon } from "../ui";

const toastIcons = { success: TablerCircleCheck, warning: TablerAlertTriangle, error: TablerCircleX };

export function ToastRegion() {
  const router = useRouter(), [toast, setToast] = createSignal<ToastMessage | null>(null);
  onSettled(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const receive = (message: ToastMessage) => {
      clearTimeout(timer);
      setToast(message);
      timer = setTimeout(() => setToast(null), 2600);
    };
    const uninstall = installToastBridge(window, receive);
    const flash = () => {
      const { toast, cleanUrl } = flashFromUrl(window.location.href);
      if (toast) receive(toast);
      if (new URL(window.location.href).searchParams.has("toast")) window.history.replaceState(window.history.state, "", cleanUrl);
    };
    flash();
    const unsubscribe = router.subscribe("onResolved", flash);
    return () => { uninstall(); unsubscribe(); clearTimeout(timer); };
  });
  return <div id="bindery-toast" role="status" aria-live="polite" aria-atomic="true" class={`toast-region ${toast() ? "is-visible" : ""}`}>
    <div class={`toast toast-${toast()?.kind || "success"}`}>
      <span class="toast-symbol" aria-hidden="true"><Icon icon={toastIcons[toast()?.kind || "success"]} /></span>
      <span class="toast-message">{toast()?.message}</span>
      <CloseButton aria-label="关闭通知" onClick={() => setToast(null)} />
    </div>
  </div>;
}
