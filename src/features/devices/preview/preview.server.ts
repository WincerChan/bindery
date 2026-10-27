import { statSync } from "node:fs";
import { requireBook } from "../../../server/http";
import { readBookArchive } from "../../../server/reader/service";
import { epubPath, type LibraryStorage } from "../../../server/storage";
import type { PreviewData } from "./model";

export function previewChapters(library: LibraryStorage, bookId: string) {
  requireBook(bookId, library);
  return readBookArchive(bookId, library).metadata().sections;
}
/** Use the synced device chapter, never derive a chapter number from book percentage. */
export function devicePageSample(library: LibraryStorage, deviceId: string, bookId: string) {
  const row = library.db.listDeviceReadingForDevice(deviceId).find(row => row.book_id === bookId);
  if (row?.section === null || row?.section === undefined) return null;
  const book = requireBook(bookId, library), section = previewChapters(library, bookId)[row.section];
  return section ? { bookId, title: book.title || "未命名", chapter: section.title, path: section.item_path } : null;
}
export function previewData(library: LibraryStorage, requested: string): PreviewData {
  const books = library.listBooks().filter(book => statSync(epubPath(library.base, book.book_id), { throwIfNoEntry: false })?.isFile())
    .map(book => ({ id: book.book_id, title: book.title || "未命名", author: book.author }));
  const bookId = books.find(book => book.id === requested)?.id ?? books[0]?.id ?? "";
  try { return { books, bookId, sections: bookId ? previewChapters(library, bookId) : [], error: requested && requested !== bookId ? "指定书籍不可预览，已选择最近更新的书籍。" : "" }; }
  catch (error) { return { books, bookId, sections: [], error: error instanceof Error ? error.message : "无法读取书籍章节" }; }
}
