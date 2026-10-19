import { statSync } from "node:fs";
import { listEpubSections } from "../../../core/epub";
import { requireBook } from "../../../server/http";
import { readBookEpub } from "../../../server/reader/service";
import { epubPath, type LibraryStorage } from "../../../server/storage";
import type { PreviewData } from "./model";

export function previewChapters(library: LibraryStorage, bookId: string) {
  requireBook(bookId, library);
  return listEpubSections(readBookEpub(bookId, library));
}
export function previewData(library: LibraryStorage, requested: string): PreviewData {
  const books = library.listBooks().filter(book => statSync(epubPath(library.base, book.book_id), { throwIfNoEntry: false })?.isFile())
    .map(book => ({ id: book.book_id, title: book.title || "未命名", author: book.author }));
  const bookId = books.find(book => book.id === requested)?.id ?? books[0]?.id ?? "";
  try { return { books, bookId, sections: bookId ? previewChapters(library, bookId) : [], error: requested && requested !== bookId ? "指定书籍不可预览，已选择最近更新的书籍。" : "" }; }
  catch (error) { return { books, bookId, sections: [], error: error instanceof Error ? error.message : "无法读取书籍章节" }; }
}
