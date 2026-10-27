import { createUniqueId, omit, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger" | "quiet-danger" | "icon";
  size?: "sm" | "md" | "lg";
  count?: JSX.Element;
};
export function Button(props: ButtonProps) {
  return <button {...omit(props, "variant", "size", "count", "class", "children")} type={props.type || "button"} title={props.title || (props.variant === "icon" ? props["aria-label"] : undefined)} class={`btn btn-${props.variant || "primary"} ${props.size ? `btn-${props.size}` : ""} ${props.class || ""}`}>
    {props.children}<Show when={props.count !== undefined}><span class="btn-count">{props.count}</span></Show>
  </button>;
}
interface FieldProps { label: string; hint?: string; error?: string; class?: string }
function descriptionId(id: string, props: FieldProps & { "aria-describedby"?: unknown }) {
  const external = typeof props["aria-describedby"] === "string" ? props["aria-describedby"] : undefined;
  return [external, props.error || props.hint ? `${id}-help` : undefined].filter(Boolean).join(" ") || undefined;
}
function FieldHelp(props: FieldProps & { id: string }) {
  return <Show when={props.error || props.hint}><span id={`${props.id}-help`} class={props.error ? "field-error" : "field-hint"}>{props.error || props.hint}</span></Show>;
}
export function TextField(props: JSX.InputHTMLAttributes<HTMLInputElement> & FieldProps & { labelHidden?: boolean }) {
  const generated = createUniqueId(), id = () => props.id || generated;
  return <label class={`field ${props.class || ""}`} for={id()}><span class={props.labelHidden ? "sr-only" : undefined}>{props.label}</span>
    <input {...omit(props, "label", "labelHidden", "hint", "error", "class")} id={id()} aria-invalid={props.error ? "true" : undefined} aria-describedby={descriptionId(id(), props)} />
    <FieldHelp {...props} id={id()} />
  </label>;
}
export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement> & FieldProps) {
  const generated = createUniqueId(), id = () => props.id || generated;
  let select!: HTMLSelectElement;
  // A controlled select must keep showing `value` when its options are rebuilt (e.g. a list refreshed
  // with new objects): removing the selected <option> makes the browser fall back to the first one,
  // and an unchanged `value` prop is never re-applied.
  onSettled(() => {
    if (typeof MutationObserver === "undefined") return;
    const sync = () => {
      const value = props.value;
      if (value !== undefined && value !== null && select.value !== String(value)) select.value = String(value);
    };
    const observer = new MutationObserver(sync);
    observer.observe(select, { childList: true, subtree: true });
    return () => observer.disconnect();
  });
  return <label class={`field ${props.class || ""}`} for={id()}><span>{props.label}</span>
    <select {...omit(props, "label", "hint", "error", "class")} ref={select} id={id()} aria-invalid={props.error ? "true" : undefined} aria-describedby={descriptionId(id(), props)} />
    <FieldHelp {...props} id={id()} />
  </label>;
}
export function Textarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps) {
  const generated = createUniqueId(), id = () => props.id || generated;
  return <label class={`field ${props.class || ""}`} for={id()}><span>{props.label}</span>
    <textarea {...omit(props, "label", "hint", "error", "class")} id={id()} aria-invalid={props.error ? "true" : undefined} aria-describedby={descriptionId(id(), props)} />
    <FieldHelp {...props} id={id()} />
  </label>;
}
