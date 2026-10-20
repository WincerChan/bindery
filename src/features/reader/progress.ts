/** Serialize writes so a slow previous request cannot overwrite a newer page. */
export class ProgressWriter {
  private latest: { section: number; page: number; page_count: number } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private stopped = false;
  constructor(private bookId: string, private report: (message: string) => void, private transport: typeof fetch = fetch) {}
  queue(section: number, page: number, page_count: number) {
    this.latest = { section, page, page_count };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 400);
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.inFlight || !this.latest) return;
    const payload = this.latest; this.latest = undefined; this.inFlight = true;
    let failed = false;
    try {
      // Native fetch rejects a ProgressWriter receiver ("Illegal invocation").
      // Invoke injected transports as functions too, so passing fetch is safe.
      const transport = this.transport;
      const response = await transport(`/book/${this.bookId}/progress`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload), keepalive: true });
      if (!response.ok || !(await response.json()).ok) throw new Error("save failed");
      if (!this.stopped) this.report("");
    } catch {
      failed = true;
      this.latest ||= payload;
      if (!this.stopped) this.report("阅读进度保存失败，将在下次翻页时重试");
    } finally {
      this.inFlight = false;
      if (!failed && this.latest) void this.flush();
    }
  }
  unload(beacon: (url: string, data: Blob) => boolean) {
    clearTimeout(this.timer);
    if (!this.latest) return;
    // Preserve ordering while an earlier keepalive request is in flight.
    if (this.inFlight) return;
    try {
      if (beacon(`/book/${this.bookId}/progress`, new Blob([JSON.stringify(this.latest)], { type: "application/json" }))) this.latest = undefined;
      else void this.flush();
    } catch { void this.flush(); }
  }
  destroy() { this.stopped = true; clearTimeout(this.timer); void this.flush(); }
}
