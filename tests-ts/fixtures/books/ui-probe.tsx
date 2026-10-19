import { renderToString } from "@solidjs/web";
import { BookDetail } from "../../../src/features/books/book-detail";
import { BookEditor } from "../../../src/features/books/book-editor";
import type { BookPage } from "../../../src/server/books/service";
export const detail = (page: BookPage) =>
  renderToString(() => <BookDetail page={page} />);
export const editor = (page: BookPage) =>
  renderToString(() => <BookEditor page={page} />);
