import { children, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

/** The one heading block for top-level pages: title, optional one-line description, optional actions. */
export function PageHeader(props: { title: JSX.Element; description?: JSX.Element; actions?: JSX.Element; class?: string }) {
  // Resolve each slot once: reading a JSX prop twice (for <Show when> and the body) would create it twice.
  const description = children(() => props.description), actions = children(() => props.actions);
  return <div class={`page-header ${props.class || ""}`}>
    <div class="page-header-text"><h1 class="page-title">{props.title}</h1><Show when={description()}><p class="page-description">{description()}</p></Show></div>
    <Show when={actions()}><div class="page-header-actions">{actions()}</div></Show>
  </div>;
}
