export let writer: ProgressWriter;
export class ProgressWriter {
  positions: { section: number; page: number; count: number }[] = [];
  destroyed = false;
  constructor(readonly book: string, readonly report: (message: string) => void) { writer = this; }
  queue(section: number, page: number, count: number) { this.positions.push({ section, page, count }); }
  unload() {}
  destroy() { this.destroyed = true; }
}
