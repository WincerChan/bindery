import { Show } from "solid-js";
import { createFileRoute, notFound } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";
import { BookDetail } from "../features/books/book-detail";
import "../features/books/books.css";
const loadBook = createServerFn({ method: "GET" })
  .middleware([authenticated])
  .inputValidator((data: { id: string; return_to?: string }) => data)
  .handler(async ({ data, context }) => {
    const { loadBookPage } = await import("../server/books/service");
    return loadBookPage(data.id, data.return_to, context.library);
  });
export const Route = createFileRoute("/_app/book/$book_id")({
  validateSearch: (search: Record<string, unknown>) => ({
    return_to:
      typeof search.return_to === "string" ? search.return_to : undefined,
  }),
  loaderDeps: ({ search }) => ({ return_to: search.return_to }),
  loader: async ({ params, deps }) => {
    try {
      return await loadBook({
        data: { id: params.book_id, return_to: deps.return_to },
      });
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 404)
        throw notFound();
      throw error;
    }
  },
  notFoundComponent: () => (
    <div>
      <h1>书籍不存在</h1>
      <a href="/">返回书库</a>
    </div>
  ),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.book.title || "书籍"} · Bindery` }],
  }),
  component: Book,
});
function Book() {
  const data = Route.useLoaderData();
  return (
    <Show when={data()} keyed>
      {(page) => <BookDetail page={page} />}
    </Show>
  );
}
