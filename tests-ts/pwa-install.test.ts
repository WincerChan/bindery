import { describe, expect, it, vi } from "vitest";
import { isIosSafari, PwaInstall, type BeforeInstallPromptEvent } from "../src/client/pwa/install";

function fakeWindow(options: { standalone?: boolean; userAgent?: string; maxTouchPoints?: number } = {}) {
  const target = Object.assign(new EventTarget(), {
    navigator: { userAgent: options.userAgent ?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36", maxTouchPoints: options.maxTouchPoints ?? 0 },
    matchMedia: vi.fn((query: string) => ({
      matches: Boolean(options.standalone) && query === "(display-mode: standalone)",
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })),
  });
  return target;
}
function installPrompt(outcome: "accepted" | "dismissed" = "accepted") {
  return Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: vi.fn(async () => ({ outcome })) }) as unknown as BeforeInstallPromptEvent;
}
describe("PWA install availability", () => {
  it("appears after beforeinstallprompt, hides after appinstalled, and uses the one-shot prompt", async () => {
    const target = fakeWindow(), install = new PwaInstall(target), states: string[] = [];
    const stop = install.subscribe(state => states.push(String(state.mode))), unstart = install.start();
    const event = installPrompt();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(install.snapshot()).toEqual({ mode: "prompt", standalone: false });
    await expect(install.prompt()).resolves.toBe(true);
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(install.snapshot()).toEqual({ mode: null, standalone: false });
    target.dispatchEvent(installPrompt());
    expect(install.snapshot().mode).toBe("prompt");
    target.dispatchEvent(new Event("appinstalled"));
    expect(install.snapshot()).toEqual({ mode: null, standalone: false });
    expect(states).toEqual(["null", "prompt", "null", "prompt", "null"]);
    stop(); unstart();
  });
  it("never offers installation inside a standalone window", () => {
    const target = fakeWindow({ standalone: true }), install = new PwaInstall(target), stop = install.start();
    target.dispatchEvent(installPrompt());
    expect(install.snapshot()).toEqual({ mode: null, standalone: true });
    stop();
  });
  it("offers iOS share-sheet guidance only in iOS Safari, not in iOS Chrome", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    const chrome = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1";
    const ipadDesktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
    expect(isIosSafari({ userAgent: iphone } as Navigator)).toBe(true);
    expect(isIosSafari({ userAgent: chrome } as Navigator)).toBe(false);
    expect(isIosSafari({ userAgent: ipadDesktop, maxTouchPoints: 5 } as Navigator)).toBe(true);
    expect(new PwaInstall(fakeWindow({ userAgent: iphone })).snapshot()).toEqual({ mode: "ios", standalone: false });
    expect(new PwaInstall(fakeWindow({ userAgent: chrome })).snapshot()).toEqual({ mode: null, standalone: false });
  });
  it("stays hidden in browsers without an install prompt or iOS guidance", () => {
    const install = new PwaInstall(fakeWindow({ userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0" }));
    expect(install.snapshot()).toEqual({ mode: null, standalone: false });
  });
});
