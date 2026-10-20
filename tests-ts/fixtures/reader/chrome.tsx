import { hydrate, renderToString } from "@solidjs/web";
import { flush, Loading } from "solid-js";
import { Reader } from "../../../src/features/reader/reader";
import type { ReaderData } from "../../../src/features/reader/model";
export { frames } from "./chrome-frame";
export { writer } from "./chrome-progress";
export const data: ReaderData = {
  book: { book_id: "d".repeat(32), title: "书名<&>", author: "作者", cover_url: null },
  sections: [{ title: "第一节", item_path: "a.xhtml" }, { title: "第二节", item_path: "b.xhtml" }],
  section_index: 0, initial_progress: null, return_to: "/jobs?tab=success",
};
export function markup() { return renderToString(() => <Loading><Reader data={data} query={new URLSearchParams()} /></Loading>); }
export function mount(root: HTMLElement) {
  const dispose = hydrate(() => <Loading><Reader data={data} query={new URLSearchParams()} /></Loading>, root);
  return { flush, dispose };
}
