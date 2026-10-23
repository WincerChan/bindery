import { canonicalZipMember } from "../../core/archive";
import { linearSpineDocumentPaths } from "../../core/epub";
import { readBookArchive } from "../reader/service";
import type { LibraryStorage } from "../storage";
import type { KindleEntry } from "./input";
import { clampFraction, clampPercent, percentFallback, type ReadingPosition } from "./position";

export type { KindleEntry } from "./input";
export type KindlePosition = ReadingPosition;

/** boko numbers KFX sections c0…cN; a cover-only spine page is merged into c0, otherwise c0 is added. */
export function mapKindlePosition(library: LibraryStorage, bookId: string, entry: KindleEntry): KindlePosition {
  const percent = clampPercent(entry.percent), archive = readBookArchive(bookId, library), sections = archive.metadata().sections;
  if (!sections.length) return { section: null, section_fraction: null, percent };
  const fallback = () => {
    const sizes = new Map<string, number>();
    for (const [name, member] of archive.members) sizes.set(canonicalZipMember(name), member.size);
    return { ...percentFallback(sections, sizes, percent), percent };
  };
  const spine = linearSpineDocumentPaths(archive);
  if (!spine.length || entry.chapter === null) return fallback();
  let document: string | null;
  if (entry.kfx_section_count === spine.length) document = spine[entry.chapter] ?? null;
  else if (entry.kfx_section_count === spine.length + 1) {
    if (entry.chapter === 0) return { section: 0, section_fraction: 0, percent };
    document = spine[entry.chapter - 1] ?? null;
  } else return fallback();
  if (!document) return fallback();
  const index = sections.findIndex(section => section.item_path === document);
  return index >= 0 ? { section: index, section_fraction: clampFraction(entry.chapter_fraction ?? 0), percent } : fallback();
}
