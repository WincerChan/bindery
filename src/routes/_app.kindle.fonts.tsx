import { createFileRoute } from "@tanstack/solid-router";
import { EmptyState } from "../ui";
export const Route = createFileRoute("/_app/kindle/fonts")({
  component: () => <EmptyState title="字体">此页面正在实现。</EmptyState>,
});
