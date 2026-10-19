export type ToastKind = "success" | "warning" | "error";
export interface ToastMessage { message: string; kind: ToastKind }
export const normalizeToastKind = (kind: unknown): ToastKind => {
  const value = String(kind || "success").trim().toLowerCase();
  return value === "error" || value === "warning" ? value : "success";
};
export function toastMessage(message: unknown, kind?: unknown): ToastMessage | null {
  const text = String(message || "").trim();
  return text ? { message: text, kind: normalizeToastKind(kind) } : null;
}
export function withToast(target: string, message: string, kind: ToastKind = "success"): string {
  if (!target.startsWith("/") || target.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(target)) target = "/";
  const url = new URL(target, "http://bindery.local");
  url.searchParams.set("toast", message);
  url.searchParams.set("toast_kind", kind);
  return `${url.pathname}${url.search}${url.hash}`;
}
export function flashFromUrl(href: string): { toast: ToastMessage | null; cleanUrl: string } {
  const url = new URL(href, "http://bindery.local");
  const toast = toastMessage(url.searchParams.get("toast"), url.searchParams.get("toast_kind"));
  url.searchParams.delete("toast");
  url.searchParams.delete("toast_kind");
  return { toast, cleanUrl: `${url.pathname}${url.search}${url.hash}` };
}
