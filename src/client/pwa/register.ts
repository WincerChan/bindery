import { showToast } from "../toast";

export const UPDATE_NOTICE = "新版本可用，刷新以更新";

/** Client-only; failures (offline, disabled SW, private mode) do not block the app. */
export function registerPwa(target: Window = window, notify = showToast): () => void {
  const serviceWorker = target.navigator.serviceWorker;
  if (!serviceWorker || !target.isSecureContext) return () => {};
  let disposed = false, applyingReload = false, notified: ServiceWorker | null = null;
  let registration: ServiceWorkerRegistration | undefined;
  let installing: ServiceWorker | null = null;
  let requestedWorker: ServiceWorker | null = null;
  let lastCheck = 0;
  const isReload = target.performance.getEntriesByType("navigation").some(entry => (entry as PerformanceNavigationTiming).type === "reload");
  const announce = () => {
    const waiting = registration?.waiting;
    if (!waiting || !serviceWorker.controller) return;
    if (notified !== waiting) { notified = waiting; notify(UPDATE_NOTICE, "warning"); }
  };
  const stateChange = () => { if (installing?.state === "installed") announce(); };
  const updateFound = () => {
    installing?.removeEventListener("statechange", stateChange);
    installing = registration?.installing ?? null;
    installing?.addEventListener("statechange", stateChange);
  };
  const controllerChange = () => {
    if (applyingReload && !disposed) { applyingReload = false; target.location.reload(); }
  };
  const message = (event: MessageEvent) => {
    if (event.source === requestedWorker && event.data?.type === "BINDERY_UPDATE_RELOADING") applyingReload = true;
  };
  const check = () => {
    if (target.document.visibilityState !== "visible" || !registration || Date.now() - lastCheck < 60_000) return;
    lastCheck = Date.now();
    announce();
    void registration.update().catch(() => {});
  };
  serviceWorker.addEventListener("controllerchange", controllerChange);
  serviceWorker.addEventListener("message", message);
  target.addEventListener("focus", check);
  target.document.addEventListener("visibilitychange", check);
  void serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then(value => {
    if (disposed) return;
    registration = value;
    registration.addEventListener("updatefound", updateFound);
    updateFound();
    announce();
    // Only a worker already waiting at an explicit browser reload can be activated.
    // The worker also checks for other tabs before accepting this message.
    if (isReload && registration.waiting && serviceWorker.controller) {
      requestedWorker = registration.waiting;
      requestedWorker.postMessage({ type: "BINDERY_ACTIVATE_ON_RELOAD" });
    }
  }).catch(() => {});
  return () => {
    disposed = true;
    serviceWorker.removeEventListener("controllerchange", controllerChange);
    serviceWorker.removeEventListener("message", message);
    target.removeEventListener("focus", check);
    target.document.removeEventListener("visibilitychange", check);
    registration?.removeEventListener("updatefound", updateFound);
    installing?.removeEventListener("statechange", stateChange);
  };
}
