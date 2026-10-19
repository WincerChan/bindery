import { createFileRoute } from "@tanstack/solid-router";
import { useKindleManager } from "../features/kindle/context";
import { FontsPage } from "../features/kindle/typeset/fonts-page";
import "../features/kindle/typeset/typeset.css";
export const Route = createFileRoute("/_app/kindle/fonts")({
  head: () => ({ meta: [{ title: "字体 · Kindle · Bindery" }] }),
  component: FontsRoute,
});
function FontsRoute() {
  const navigate = Route.useNavigate(), manager = useKindleManager();
  return <FontsPage manager={manager} onPreview={font => navigate({ to: "/kindle/preview", search: { font } })} />;
}
