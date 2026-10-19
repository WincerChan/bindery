import { createFileRoute } from "@tanstack/solid-router";
import { EmptyState } from "../ui";
export const Route = createFileRoute("/_app/kindle/")({
  component: () => <EmptyState title="设备书籍">此页面正在实现。</EmptyState>,
});
