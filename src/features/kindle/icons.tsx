import { Show } from "solid-js";

export function KindleIcon(props: { name: "eye" | "redo" | "trash" | "device" | "warning" | "info" }) {
  return <svg width={props.name === "device" ? 28 : 18} height={props.name === "device" ? 36 : 18}
    viewBox={props.name === "device" ? "0 0 44 56" : "0 0 18 18"} fill="none" aria-hidden="true">
    <Show when={props.name === "eye"}><path d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z" stroke="currentColor" stroke-width="1.5" /><circle cx="9" cy="9" r="2.2" stroke="currentColor" stroke-width="1.5" /></Show>
    <Show when={props.name === "redo"}><path d="M15 9a6 6 0 1 1-1.8-4.3M15 3v3.5h-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></Show>
    <Show when={props.name === "trash"}><path d="M3 5h12M7 5V3h4v2M5 5l.8 10h6.4L13 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></Show>
    <Show when={props.name === "device"}><rect x="1" y="1" width="42" height="54" rx="6" stroke="currentColor" stroke-width="2.5" /><rect x="7" y="7" width="30" height="38" rx="1" fill="var(--color-line-soft)" /></Show>
    <Show when={props.name === "warning"}><path d="M9 2l7.5 13h-15L9 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /><path d="M9 7v4M9 13v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></Show>
    <Show when={props.name === "info"}><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5" /><path d="M9 4.5v5.8M9 13.2v.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></Show>
  </svg>;
}
