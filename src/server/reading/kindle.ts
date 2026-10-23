import { canonicalZipMember } from "../../core/archive";
import { readBookArchive } from "../reader/service";
import type { LibraryStorage } from "../storage";
import type { KindleEntry } from "./input";
import { clampFraction, clampPercent, percentFallback, type ReadingPosition } from "./position";

export type { KindleEntry } from "./input";
export type KindlePosition = ReadingPosition;

/** Exact chapter mapping is only trusted when Kindle's section count matches the reader's sections. */
export function mapKindlePosition(library: LibraryStorage, bookId: string, entry: KindleEntry): KindlePosition {
  const percent = clampPercent(entry.percent), archive = readBookArchive(bookId, library), sections = archive.metadata().sections;
  if (!sections.length) return { section: null, section_fraction: null, percent };
  if (entry.chapter !== null && entry.chapter_count === sections.length && entry.chapter >= 0 && entry.chapter < sections.length) {
    return { section: entry.chapter, section_fraction: clampFraction(entry.chapter_fraction ?? 0), percent };
  }
  const sizes = new Map<string, number>();
  for (const [name, member] of archive.members) sizes.set(canonicalZipMember(name), member.size);
  return { ...percentFallback(sections, sizes, percent), percent };
}
