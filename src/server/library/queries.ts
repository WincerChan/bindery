import { ensureTrackerConsistencyForMeta } from "../tracker";
import { bookView } from "../book-view";
import type { LibraryStorage } from "../storage";
import { HttpError } from "../http";
import { libraryQueryInput, libraryReturnTo, normalizeSearch, type LibrarySearch } from "../../features/library/search";

export function loadLibraryPage(library: LibraryStorage, input: ReturnType<typeof libraryQueryInput>) {
  if (input.invalid) throw new HttpError(422, "分页参数必须为整数");
  return libraryPage(library, input.search);
}

export function libraryPage(library: LibraryStorage, input: Partial<LibrarySearch> = {}) {
  const search = normalizeSearch(input);
  let [books, total_books] = library.listBooksPage(search);
  const total_pages = Math.max(1, Math.ceil(total_books / search.per_page));
  const page = Math.min(search.page, total_pages);
  if (page !== search.page) [books] = library.listBooksPage({ ...search, page });
  const current = { ...search, page };
  return {
    ...current, books: books.map(meta => bookView(meta, library, meta.archived ? undefined : ensureTrackerConsistencyForMeta(meta, library))), total_books, total_pages,
    has_prev: page > 1, has_next: page < total_pages, prev_page: page - 1, next_page: page + 1,
    return_to: libraryReturnTo(current),
  };
}
export type LibraryPageData = ReturnType<typeof libraryPage>;
