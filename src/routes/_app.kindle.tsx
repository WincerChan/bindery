import { createFileRoute } from "@tanstack/solid-router";
import { EmptyState } from "../ui";
export const Route = createFileRoute("/_app/kindle")({
  head: () => ({ meta: [{ title: "Kindle · Bindery" }] }),
  component: () => <><h1>Kindle</h1><EmptyState title="Kindle 设备管理">浏览器转换与 USB 传书将在阶段 4 提供。</EmptyState></>,
});
