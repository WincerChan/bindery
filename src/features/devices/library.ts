import type { BookView } from "../../server/book-view";
import type { LibraryPageData } from "../../server/library/queries";
import type { DeviceKind } from "../../client/devices/models";
import { koboBookFilename } from "../../client/devices/paths";
import { createLibraryMatcher } from "../../core/fingerprint";

export type DeviceLibraryBook = Pick<BookView, "book_id" | "title" | "author" | "cover_url" | "read">;
export type KindleLibraryBook = DeviceLibraryBook;
export interface DeviceIdentityInput { book_id?: string | null; fingerprint?: string | null; filename: string }
export interface DeviceLibraryResolver { match(book: DeviceIdentityInput): string | null }
export type DeviceLibraryResolverFactory = (books: readonly DeviceLibraryBook[], kind: DeviceKind) => Promise<DeviceLibraryResolver>;
/** One matching order for every page: book id, fingerprint, then Kobo's unique filename. */
export async function createDeviceLibraryResolver(books: readonly DeviceLibraryBook[], kind: DeviceKind = "kindle"): Promise<DeviceLibraryResolver> {
  const matcher = await createLibraryMatcher(books), filenames = new Map<string, string | null>();
  if (kind === "kobo") for (const book of books) {
    const filename = `Bindery/${koboBookFilename(book.title)}`.toLowerCase(), current = filenames.get(filename);
    if (current === undefined) filenames.set(filename, book.book_id);
    else if (current !== book.book_id) filenames.set(filename, null);
  }
  return { match: book => matcher.match(book) ?? (kind === "kobo" ? filenames.get(book.filename.toLowerCase()) ?? null : null) };
}
/** Reuse the existing authenticated, paginated query without silently dropping books after page 1. */
export async function loadDeviceLibrary(load: (page: number) => Promise<LibraryPageData>): Promise<DeviceLibraryBook[]> {
  const first = await load(1), books = new Map(first.books.map(b => [b.book_id, b]));
  for (let page = 2; page <= first.total_pages; page++) for (const book of (await load(page)).books) books.set(book.book_id, book);
  return [...books.values()].map(({ book_id, title, author, cover_url, read }) => ({ book_id, title, author, cover_url, read }));
}
export const loadKindleLibrary = loadDeviceLibrary;
