import { renderToString } from "@solidjs/web";
import { Reader } from "../../../src/features/reader/reader";
import type { ReaderData } from "../../../src/features/reader/model";
export function renderReader(query = "") {
  const data: ReaderData = { book: { book_id: "d".repeat(32), title: "书名<&>", author: "作者", cover_url: "/book/d/cover?v=1" }, sections: [{ title: "第一章<&>", item_path: "Text/第一章.xhtml" }, { title: "第二章", item_path: "Text/ch2.xhtml" }], section_index: 0, initial_progress: { book_id: "d".repeat(32), section: 1, page: 3, page_count: 8, updated_at: "2026-10-19" }, return_to: "/jobs?tab=success" };
  return renderToString(() => <Reader data={data} query={new URLSearchParams(query)} />);
}
