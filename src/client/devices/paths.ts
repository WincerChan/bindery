import { assertWindowsWritePath } from "./fs";

// X:\documents\<stem>.sdr\<stem><32 hex>.yjr.bad_file = 63 + 2*stem.length.
// Keep that worst case <= 240 UTF-16 units (20 units below MAX_PATH), suffix included.
export const BOOK_STEM_BUDGET = 88;
export function fitStem(name: string, budget: number): string {
  while (name.length > budget || new TextEncoder().encode(name).length > 180) name = Array.from(name).slice(0, -1).join("");
  return name.replace(/[. ]+$/g, "");
}
export function safeBookStem(title: string): string {
  let name = title.normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").trim().replace(/[. ]+$/g, "");
  if (!name || name === "." || name === "..") name = "book";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return fitStem(name, BOOK_STEM_BUDGET);
}
export const koboBookFilename = (title: string) => `${safeBookStem(title)}.kepub.epub`;
export function assertDeviceBookPath(path: string) {
  assertWindowsWritePath(path);
}
