import type { Metadata, Wish } from "../core/models";
import { strip } from "../core/python";
import { nowIso } from "./db";
import { wishIdentity } from "./db/encoding";
import { newBookId, type LibraryStorage } from "./storage";

const identity = (value: string | null) => wishIdentity(value, null)[0];
export const normalizedLibraryBookId = (raw: string | null) => {
  const id = strip(raw || "").toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
};
/** Optional index is consumed as manual entries are linked during a library scan. */
export function ensureTrackerForBook(meta: Metadata, library: LibraryStorage, unlinked?: Map<string, Wish[]>): Wish {
  let wish = library.db.getWishByLibraryBookId(meta.book_id);
  const now = nowIso();
  if (!wish) {
    const title = identity(meta.title), author = identity(meta.author);
    const candidates = unlinked ? unlinked.get(title) || [] : library.db.listWishes();
    wish = title ? candidates.find(w => !normalizedLibraryBookId(w.library_book_id) && identity(w.title) === title && (!author || !identity(w.author) || author === identity(w.author))) || null : null;
    if (!wish) {
      wish = { id: newBookId(), library_book_id: meta.book_id, title: meta.title || "未命名", author: meta.author, rating: meta.rating, read: meta.read, read_status: meta.read ? "read" : "unread", tags: [], comment: null, book_status: "completed", created_at: now, updated_at: now };
      library.db.createWish(wish);
      return wish;
    }
    if (unlinked) unlinked.set(title, candidates.filter(w => w.id !== wish!.id));
  }
  const fields: Partial<Wish> = {};
  if (wish.library_book_id !== meta.book_id) fields.library_book_id = meta.book_id;
  if ((wish.title || "") !== (meta.title || "")) fields.title = meta.title || "未命名";
  if ((wish.author || null) !== (meta.author || null)) fields.author = meta.author || null;
  if (Object.keys(fields).length) {
    library.db.updateWish(wish.id, { ...fields, updated_at: now });
    wish = library.db.getWishByLibraryBookId(meta.book_id) || wish;
  }
  return wish;
}
/** Only the read cache timestamp changes; metadata/EPUB write-back state stays intact. */
export function applyTrackerStateToMetadataCache(meta: Metadata, wish: Wish): boolean {
  const read = strip(wish.read_status || (wish.read ? "read" : "unread")).toLowerCase() === "read";
  const changed = meta.read !== read || meta.rating !== wish.rating;
  if (meta.read !== read) { meta.read = read; meta.read_updated_at = nowIso(); }
  meta.rating = wish.rating;
  return changed;
}
export function syncTrackerMetadata(library: LibraryStorage, wish: Wish, matchId = wish.library_book_id): void {
  const id = normalizedLibraryBookId(matchId || wish.library_book_id);
  if (!id || !library.ensureBookExists(id)) return;
  const meta = library.loadMetadata(id);
  if (applyTrackerStateToMetadataCache(meta, wish)) library.saveMetadata(meta);
}
export function ensureTrackerConsistencyForMeta(meta: Metadata, library: LibraryStorage): Wish {
  const wish = ensureTrackerForBook(meta, library);
  if (applyTrackerStateToMetadataCache(meta, wish)) library.saveMetadata(meta);
  return wish;
}
