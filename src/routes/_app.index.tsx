import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../server/functions";

const getBookCount = createServerFn({ method: "GET" }).middleware([authenticated]).handler(async () => {
  const { readBookCount } = await import("../server/database");
  return readBookCount();
});
export const Route = createFileRoute("/_app/")({
  loader: () => getBookCount(),
  component: Home,
});
function Home() {
  const data = Route.useLoaderData();
  return (
    <div>
      <h1>书库</h1>
      <p class="mt-6 text-xl">
        书库共有 <strong data-testid="book-count">{data().count}</strong> 本书
      </p>
      <p class="mt-3 text-stone-600">
        {data().missing ? "尚未找到书库数据库。" : "已连接现有书库。"}
      </p>
      <p class="mt-6"><a href="/security">安全设置</a></p>
    </div>
  );
}
