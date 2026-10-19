import type { BookView } from "../../../server/book-view";
import type { LibraryPageData } from "../../../server/library/queries";

export type KindleLibraryBook = Pick<BookView, "book_id" | "title" | "author" | "cover_url" | "read">;
/** Reuse the existing authenticated, paginated query without silently dropping books after page 1. */
export async function loadKindleLibrary(load: (page: number) => Promise<LibraryPageData>): Promise<KindleLibraryBook[]> {
  const first = await load(1), books = new Map(first.books.map(b => [b.book_id, b]));
  for (let page = 2; page <= first.total_pages; page++) for (const book of (await load(page)).books) books.set(book.book_id, book);
  return [...books.values()].map(({ book_id, title, author, cover_url, read }) => ({ book_id, title, author, cover_url, read }));
}
