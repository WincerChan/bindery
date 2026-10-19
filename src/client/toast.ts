import { toastMessage, type ToastKind, type ToastMessage } from "../shared/notifications";

declare global { interface Window { binderyToast?: typeof showToast } }
export function showToast(message: string, kind: ToastKind = "success"): void {
  if (typeof document !== "undefined") document.body.dispatchEvent(new CustomEvent("bindery:toast", { detail: { message, kind } }));
}
/** Bridge also accepts Python/HTMX's detail.value envelope. No shared SSR state. */
export function installToastBridge(target: Window, receive: (toast: ToastMessage) => void): () => void {
  const previous = target.binderyToast;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const payload = detail && typeof detail.value === "object" ? detail.value : detail;
    const toast = toastMessage(payload?.message, payload?.kind);
    if (toast) receive(toast);
  };
  target.binderyToast = showToast;
  target.document.body.addEventListener("bindery:toast", listener);
  return () => {
    target.document.body.removeEventListener("bindery:toast", listener);
    target.binderyToast = previous;
  };
}
