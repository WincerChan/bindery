import { renderToString } from "@solidjs/web";
import { LibraryBook, LibraryPage, LibrarySection } from "../../../src/features/library/library-page";
import { ArchivePage } from "../../../src/features/library/archive-page";
import { metadataFromDict } from "../../../src/core/models";
import type { BookView } from "../../../src/server/book-view";
import type { LibraryPageData } from "../../../src/server/library/queries";
import { libraryReturnTo } from "../../../src/features/library/search";

function book(prefix = "00", cover_url: string | null = null): BookView {
  return { ...metadataFromDict({ book_id: prefix + "a".repeat(30), title: "长安<&>的荔枝", author: "马伯庸", updated_at: "2026-10-19T08:09:10+00:00", read: true }), status_class: "ok", status_label: "已写回元数据", effective_theme_template: "default", can_regenerate: true, path: "/private/library", cover_url };
}
function data(empty = false): LibraryPageData {
  return { sort: "updated", q: "长安", page: 2, read_filter: "unread", per_page: 24, books: empty ? [] : [book()], total_books: empty ? 0 : 49, total_pages: empty ? 1 : 3, has_prev: true, has_next: true, prev_page: 1, next_page: 3, return_to: libraryReturnTo({ q: "长安", page: 2, read_filter: "unread" }) };
}
export function item(prefix: string, cover: string | null, view: "grid" | "list", selecting = false) {
  return renderToString(() => <LibraryBook book={book(prefix, cover)} view={view} returnTo={data().return_to} selecting={selecting} selected={selecting} toggle={() => {}} />);
}
export function page(empty = false) { return renderToString(() => <LibraryPage data={data(empty)} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />); }
export function section() { return renderToString(() => <LibrarySection data={data()} view="list" selecting selected={[book().book_id]} />); }
export function archive(empty = false) { return renderToString(() => <ArchivePage books={empty ? [] : [book()]} restore={async () => {}} refresh={async () => {}} />); }
