import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPwa, UPDATE_NOTICE } from "../src/client/pwa/register";

function harness(navigation = "navigate") {
  const waiting = Object.assign(new EventTarget(), { state: "installed", postMessage: vi.fn() });
  const registration = Object.assign(new EventTarget(), { waiting: waiting as typeof waiting | null, installing: null as typeof waiting | null, update: vi.fn().mockResolvedValue(undefined) });
  const container = Object.assign(new EventTarget(), { controller: {} as object | null, register: vi.fn().mockResolvedValue(registration) });
  const target = Object.assign(new EventTarget(), {
    isSecureContext: true,
    navigator: { serviceWorker: container },
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    performance: { getEntriesByType: () => [{ type: navigation }] },
    location: { reload: vi.fn() },
  });
  const notify = vi.fn();
  const start = () => registerPwa(target as unknown as Window, notify);
  const flush = () => new Promise(resolve => queueMicrotask(() => resolve(undefined)));
  return { waiting, registration, container, target, notify, start, flush };
}
afterEach(() => vi.restoreAllMocks());
describe("safe PWA registration", () => {
  it("registers at the root with a fresh update check and uses the existing toast", async () => {
    const h = harness(), cleanup = h.start(); await h.flush();
    expect(h.container.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
    expect(h.notify).toHaveBeenCalledWith(UPDATE_NOTICE, "warning");
    expect(h.waiting.postMessage).not.toHaveBeenCalled();
    h.container.dispatchEvent(new Event("controllerchange"));
    expect(h.target.location.reload).not.toHaveBeenCalled(); cleanup();
  });
  it("activates only at a deliberate reload and reloads only after the worker acknowledges", async () => {
    const h = harness("reload"), cleanup = h.start(); await h.flush();
    expect(h.waiting.postMessage).toHaveBeenCalledWith({ type: "BINDERY_ACTIVATE_ON_RELOAD" });
    h.container.dispatchEvent(new Event("controllerchange"));
    expect(h.target.location.reload).not.toHaveBeenCalled();
    const event = new Event("message"); Object.assign(event, { source: h.waiting, data: { type: "BINDERY_UPDATE_RELOADING" } });
    h.container.dispatchEvent(event); h.container.dispatchEvent(new Event("controllerchange")); h.container.dispatchEvent(new Event("controllerchange"));
    expect(h.target.location.reload).toHaveBeenCalledTimes(1); cleanup();
  });
  it("announces a newly installed update without activating during the session", async () => {
    const h = harness(); h.registration.waiting = null; const cleanup = h.start(); await h.flush();
    h.registration.installing = h.waiting;
    h.registration.dispatchEvent(new Event("updatefound")); h.registration.waiting = h.waiting;
    h.waiting.dispatchEvent(new Event("statechange")); h.waiting.dispatchEvent(new Event("statechange"));
    expect(h.notify).toHaveBeenCalledTimes(1); expect(h.waiting.postMessage).not.toHaveBeenCalled(); cleanup();
  });
  it("does not announce the first installation as an update", async () => {
    const h = harness("reload"); h.container.controller = null;
    const cleanup = h.start(); await h.flush();
    expect(h.notify).not.toHaveBeenCalled(); expect(h.waiting.postMessage).not.toHaveBeenCalled(); cleanup();
  });
  it("checks on visible focus, throttles checks and removes listeners", async () => {
    const h = harness(), cleanup = h.start(); await h.flush();
    h.target.document.visibilityState = "hidden"; h.target.dispatchEvent(new Event("focus"));
    expect(h.registration.update).not.toHaveBeenCalled();
    h.target.document.visibilityState = "visible"; h.target.document.dispatchEvent(new Event("visibilitychange")); h.target.dispatchEvent(new Event("focus"));
    expect(h.registration.update).toHaveBeenCalledTimes(1);
    cleanup(); h.target.dispatchEvent(new Event("focus"));
    expect(h.registration.update).toHaveBeenCalledTimes(1);
  });
  it("tolerates registration failure and disposes safely before registration resolves", async () => {
    const h = harness(); h.container.register.mockRejectedValueOnce(new Error("offline"));
    const cleanup = h.start(); await h.flush(); cleanup();
    expect(h.notify).not.toHaveBeenCalled();
    const late = harness(); late.start()(); await late.flush(); expect(late.notify).not.toHaveBeenCalled();
  });
  it("skips insecure contexts", () => {
    const h = harness(); h.target.isSecureContext = false; h.start()(); expect(h.container.register).not.toHaveBeenCalled();
  });
});
