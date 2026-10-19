import { createFileRoute } from "@tanstack/solid-router";
import { EmptyState } from "../ui";
export const Route = createFileRoute("/_app/kindle/preview")({
  component: () => <EmptyState title="排版与预览">此页面正在实现。</EmptyState>,
});
