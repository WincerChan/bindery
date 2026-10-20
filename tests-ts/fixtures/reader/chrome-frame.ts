import type { ReaderData, ReaderSettings } from "../../../src/features/reader/model";
import type { ReaderLocation } from "../../../src/features/reader/frame";

// Layout belongs to ReaderFrames tests. This boundary lets the actual Reader
// hydrate and exercise its chrome without inventing iframe layout in xmldom.
export let frames: ReaderFrames;
export class ReaderFrames {
  configurations: ReaderSettings[] = [];
  turns: number[] = [];
  keys: string[] = [];
  opens: { section: number; page: number; find: string }[] = [];
  destroyed = false;
  location: ReaderLocation;
  constructor(readonly data: ReaderData, readonly elements: HTMLIFrameElement[], initial: { section: number; page: number }, readonly change: (value: ReaderLocation) => void, readonly busy: (value: boolean) => void, readonly error: (value: string) => void) {
    frames = this;
    this.location = { ...initial, pageCount: 3, frame: 0 };
    this.publish(this.location);
  }
  publish(value: ReaderLocation) { this.location = value; this.change(value); this.busy(false); }
  configure(value: ReaderSettings) { this.configurations.push({ ...value }); }
  open(section: number, page = 1, find = "") { this.opens.push({ section, page, find }); this.publish({ ...this.location, section, page, frame: 1 }); }
  turn(direction: -1 | 1) { this.turns.push(direction); }
  key(event: KeyboardEvent) { this.keys.push(event.key); }
  retry() { this.error(""); }
  destroy() { this.destroyed = true; }
}
