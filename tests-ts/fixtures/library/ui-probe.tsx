import { renderToString } from "@solidjs/web";
import { LibraryBook, LibraryPage, LibrarySection } from "../../../src/features/library/library-page";
import { metadataFromDict } from "../../../src/core/models";
import type { BookView } from "../../../src/server/book-view";
import type { LibraryPageData } from "../../../src/server/library/queries";
import { libraryReturnTo } from "../../../src/features/library/search";
import type { LibrarySummary } from "../../../src/features/library/summary";

function book(prefix = "00", cover_url: string | null = null): BookView {
  return { ...metadataFromDict({ book_id: prefix + "a".repeat(30), title: "长安<&>的荔枝", author: "马伯庸", updated_at: "2026-10-19T08:09:10+00:00", read: true }), status_class: "ok", status_label: "已写回元数据", effective_theme_template: "default", can_regenerate: true, path: "/private/library", cover_url };
}
function data(empty = false): LibraryPageData {
  return { scope: "active", sort: "updated", q: "长安", page: 2, read_filter: "unread", per_page: 24, books: empty ? [] : [book()], total_books: empty ? 0 : 49, total_pages: empty ? 1 : 3, has_prev: true, has_next: true, prev_page: 1, next_page: 3, return_to: libraryReturnTo({ q: "长安", page: 2, read_filter: "unread" }) };
}
export function item(prefix: string, cover: string | null, view: "grid" | "list", selecting = false, state?: "failed" | "generating") {
  return renderToString(() => <LibraryBook book={{ ...book(prefix, cover), status_class: state === "failed" ? "failed" : "ok", read: !state }} generating={state === "generating"} view={view} returnTo={data().return_to} selecting={selecting} selected={selecting} toggle={() => {}} />);
}
export function introduction(title: string, reading = true) {
  const summary: LibrarySummary = { active_count: 51, archived_count: 7, hero: { ...book(), title }, latest: reading ? { section: 2, read_at: "2026-10-22T13:00:00Z" } : null, generating_ids: [] };
  return renderToString(() => <LibraryPage data={{ ...data(true), summary }} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />);
}
export function page(empty = false) { return renderToString(() => <LibraryPage data={data(empty)} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />); }
export function section() { return renderToString(() => <LibrarySection data={data()} view="list" selecting selected={[book().book_id]} />); }
export function singlePage() {
  const current: LibraryPageData = { ...data(), page: 1, total_books: 1, total_pages: 1, has_prev: false, has_next: false, books: [book()] };
  return renderToString(() => <LibraryPage data={current} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />);
}
export function archive(empty = false, view: "grid" | "list" = "grid") {
  const current: LibraryPageData = { ...data(empty), scope: "archived", read_filter: "all", books: empty ? [] : [{ ...book("00", "/private-cover"), archived: true }], return_to: libraryReturnTo({ scope: "archived", page: 2 }) };
  return renderToString(() => <LibraryPage data={current} initialView={view} restore={async () => {}} refresh={async () => {}} regenerate={async () => ({ queued: 0, failed: 0, skipped: 0 })} />);
}
