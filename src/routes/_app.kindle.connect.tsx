import { createFileRoute } from "@tanstack/solid-router";
import { EmptyState } from "../ui";
export const Route = createFileRoute("/_app/kindle/connect")({
  component: () => <EmptyState title="连接与识别设备">此页面正在实现。</EmptyState>,
});
