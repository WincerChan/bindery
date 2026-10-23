import { basename, canonicalZipMember } from "../../core/archive";
import { koboMemberRenames } from "../../core/epub-safe-paths";
import { readBookArchive } from "../reader/service";
import type { LibraryStorage } from "../storage";
import type { KoboEntry } from "./input";
import { clampFraction, clampPercent, percentFallback, type ReadingPosition } from "./position";

export type { KoboEntry } from "./input";
export type KoboPosition = ReadingPosition;

/** Kobo chapter paths are library member paths, sanitized member paths, or a kepubify dummy first page. */
export function mapKoboPosition(library: LibraryStorage, bookId: string, entry: KoboEntry): KoboPosition {
  const percent = clampPercent(entry.percent);
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
  if (index >= 0) return { section: index, section_fraction: clampFraction(entry.chapter_fraction ?? 0), percent };
  return { ...percentFallback(sections, sizes, percent), percent };
}
