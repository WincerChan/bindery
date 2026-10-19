import { guessMediaType } from "../../core/epub";
import { createEpubAssetStripper } from "../../core/epub-strip";
import { HttpError, requireBook } from "../http";
import type { ReaderArchive } from "../reader/archive";
import { epubMemberResponse, validateItemPath } from "../reader/resources";
import { readBookArchive } from "../reader/service";
import type { LibraryStorage } from "../storage";

// Weak keys share the reader's identity/invalidation and bounded LRU lifetime. Plans
// retain only metadata/names; member bytes are read and transformed on demand.
const plans = new WeakMap<ReaderArchive, Map<string, ReturnType<typeof createEpubAssetStripper>>>();
export function kindlePreviewArchive(archive: ReaderArchive, mode: string) {
  if (!/^[01]{2}$/.test(mode)) throw new HttpError(404, "资源不存在");
  let modes = plans.get(archive);
  if (!modes) { modes = new Map(); plans.set(archive, modes); }
  let plan = modes.get(mode);
  if (!plan) {
    plan = createEpubAssetStripper(archive, archive.members.keys(), {
      stripFonts: mode[0] === "1", stripImages: mode[1] === "1",
    }, undefined, archive.resolve.bind(archive), bytes => archive.retainMetadata(bytes));
    modes.set(mode, plan);
    archive.retainMetadata(plan.weight());
  }
  return plan;
}

/** A read-only, indexed preview of the same member transformations used before conversion. */
export function kindlePreviewResource(request: Request, bookId: string, mode: string, rawPath: string, library: LibraryStorage): Response {
  requireBook(bookId, library);
  if (!/^[01]{2}$/.test(mode)) throw new HttpError(404, "资源不存在");
  const archive = kindlePreviewArchive(readBookArchive(bookId, library), mode);
  const path = validateItemPath(rawPath, archive), content = archive.read(path);
  if (!content) throw new HttpError(404, "资源不存在");
  let media = guessMediaType(path);
  if (media === "application/octet-stream") media = archive.mediaType(path) || media;
  return epubMemberResponse(request, `/kindle/content/${bookId}/${mode}/epub/`, path, archive, content, media, { "Cache-Control": "no-store" });
}
