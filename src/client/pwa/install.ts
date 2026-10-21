export type InstallMode = "prompt" | "ios";
export interface InstallState {
  mode: InstallMode | null;
  standalone: boolean;
}
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}
interface InstallWindow {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  matchMedia?(query: string): { matches: boolean; addEventListener?(type: string, listener: EventListener): void; removeEventListener?(type: string, listener: EventListener): void };
  navigator?: { userAgent?: string; maxTouchPoints?: number; standalone?: boolean };
}
export function isStandalone(target: InstallWindow): boolean {
  if (target.navigator?.standalone) return true;
  try { return target.matchMedia?.("(display-mode: standalone)")?.matches ?? false; } catch { return false; }
}
export function isIosSafari(navigator: { userAgent?: string; maxTouchPoints?: number; standalone?: boolean } | undefined): boolean {
  const ua = navigator?.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || /Macintosh/.test(ua) && Number(navigator?.maxTouchPoints ?? 0) > 1;
  return ios && /Safari/.test(ua) && !/(?:CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Android)/i.test(ua);
}
/** Tracks installability without touching the Service Worker or its update flow. */
export class PwaInstall {
  private promptEvent: BeforeInstallPromptEvent | null = null;
  private listeners = new Set<(state: InstallState) => void>();
  private started = false;
  constructor(private readonly target: InstallWindow) {}
  snapshot(): InstallState {
    const standalone = isStandalone(this.target);
    if (standalone) return { mode: null, standalone: true };
    if (this.promptEvent) return { mode: "prompt", standalone: false };
    return { mode: isIosSafari(this.target.navigator) ? "ios" : null, standalone: false };
  }
  subscribe(listener: (state: InstallState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }
  start(): () => void {
    if (this.started) return () => {};
    this.started = true;
    const previous = this.snapshot();
    const onPrompt = (event: Event) => {
      const prompt = event as BeforeInstallPromptEvent;
      if (typeof prompt.prompt !== "function") return;
      prompt.preventDefault();
      this.promptEvent = prompt;
      this.notify();
    };
    const onInstalled = () => { this.promptEvent = null; this.notify(); };
    const media = this.target.matchMedia?.("(display-mode: standalone)");
    const onDisplayMode = () => this.notify();
    this.target.addEventListener("beforeinstallprompt", onPrompt);
    this.target.addEventListener("appinstalled", onInstalled);
    media?.addEventListener?.("change", onDisplayMode);
    // matchMedia may have been too early during hydration.
    if (this.snapshot().standalone !== previous.standalone) this.notify();
    return () => {
      this.started = false;
      this.target.removeEventListener("beforeinstallprompt", onPrompt);
      this.target.removeEventListener("appinstalled", onInstalled);
      media?.removeEventListener?.("change", onDisplayMode);
    };
  }
  async prompt(): Promise<boolean> {
    const event = this.promptEvent;
    if (!event) return false;
    // A beforeinstallprompt event is single-use; hide it even if dismissed.
    this.promptEvent = null;
    this.notify();
    const choice = await event.prompt();
    return choice.outcome === "accepted";
  }
  private notify(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}
