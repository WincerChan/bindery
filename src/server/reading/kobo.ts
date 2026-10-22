import { basename, canonicalZipMember } from "../../core/archive";
import { koboMemberRenames } from "../../core/epub-safe-paths";
import { readBookArchive } from "../reader/service";
import type { LibraryStorage } from "../storage";
import type { KoboEntry } from "./input";

export type { KoboEntry } from "./input";
export interface KoboPosition {
  section: number | null;
  section_fraction: number | null;
  percent: number;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const percentFallback = (sections: { item_path: string }[], sizes: Map<string, number>, percent: number): Pick<KoboPosition, "section" | "section_fraction"> => {
  if (!sections.length) return { section: null, section_fraction: null };
  const weights = sections.map(section => Math.max(0, sizes.get(section.item_path) ?? 0)), total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return { section: 0, section_fraction: 0 };
  const target = percent / 100 * total;
  let start = 0;
  for (let index = 0; index < weights.length; index++) {
    const end = start + weights[index];
    if (target < end || index === weights.length - 1) return { section: index, section_fraction: weights[index] ? clamp((target - start) / weights[index]) : 0 };
    start = end;
  }
  return { section: sections.length - 1, section_fraction: 1 };
};

/** Kobo chapter paths are library member paths, sanitized member paths, or a kepubify dummy first page. */
export function mapKoboPosition(library: LibraryStorage, bookId: string, entry: KoboEntry): KoboPosition {
  const percent = Number.isFinite(entry.percent) ? Math.max(0, Math.min(100, entry.percent)) : 0;
  if (entry.last_read_at === null && entry.percent === 0) return { section: null, section_fraction: null, percent };
  const archive = readBookArchive(bookId, library), sections = archive.metadata().sections;
  const sizes = new Map<string, number>();
  for (const [name, member] of archive.members) sizes.set(canonicalZipMember(name), member.size);
  if (!sections.length) return { section: null, section_fraction: null, percent };
  const path = canonicalZipMember((entry.location ?? "").split("#")[0]);
  if (path && basename(path) === "kepubify-titlepage-dummy.xhtml") return { section: 0, section_fraction: 0, percent };
  let index = path ? sections.findIndex(section => section.item_path === path) : -1;
  if (index < 0 && path) {
    const original = koboMemberRenames([...archive.members.keys()].map(canonicalZipMember)).get(path);
    if (original) index = sections.findIndex(section => section.item_path === original);
  }
  if (index >= 0) return { section: index, section_fraction: clamp(entry.chapter_fraction ?? 0), percent };
  return { ...percentFallback(sections, sizes, percent), percent };
}
