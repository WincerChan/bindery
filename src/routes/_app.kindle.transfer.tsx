import { createFileRoute } from "@tanstack/solid-router";
import { EmptyState } from "../ui";
export const Route = createFileRoute("/_app/kindle/transfer")({
  component: () => <EmptyState title="传书">此页面正在实现。</EmptyState>,
});
