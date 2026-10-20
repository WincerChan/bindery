import { useLocation, useRouter } from "@tanstack/solid-router";
import { createSignal, onSettled, type ComponentProps } from "solid-js";
import { isServer } from "@solidjs/web";
import { IngestPage } from "./page";
import { jobsSheetOpen, jobsSheetTarget } from "./search";

export function IngestScreen(props: { data: Pick<ComponentProps<typeof IngestPage>, "options" | "jobs"> }) {
  const router = useRouter(), location = useLocation();
  const [ready, setReady] = createSignal(false);
  onSettled(() => { setReady(true); });
  // Fragments are not sent to SSR. Apply them after hydration so dialog/ARIA state stays in sync.
  const open = () => jobsSheetOpen(!isServer && !ready() ? location().href.split("#")[0]! : location().href);
  const navigate = (href: string) => router.navigate({ href, replace: true, resetScroll: false, hashScrollIntoView: false });
  return <IngestPage options={props.data.options} jobs={props.data.jobs} jobsOpen={open()} openJobs={() => navigate(jobsSheetTarget(location().href, true))} closeJobs={() => navigate(jobsSheetTarget(location().href, false))} navigateJobs={navigate} />;
}
