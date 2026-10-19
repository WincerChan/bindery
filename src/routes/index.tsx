import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";

const getBookCount = createServerFn({ method: "GET" }).handler(async () => {
  const { readBookCount } = await import("../server/database");
  return readBookCount();
});
export const Route = createFileRoute("/")({
  loader: () => getBookCount(),
  component: Home,
});
function Home() {
  const data = Route.useLoaderData();
  return (
    <main class="mx-auto max-w-3xl px-6 py-16">
      <h1 class="text-4xl font-semibold">Bindery</h1>
      <p class="mt-6 text-xl">
        书库共有 <strong data-testid="book-count">{data().count}</strong> 本书
      </p>
      <p class="mt-3 text-stone-600">
        {data().missing ? "尚未找到书库数据库。" : "已连接现有书库。"}
      </p>
    </main>
  );
}
