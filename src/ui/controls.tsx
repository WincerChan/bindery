import { createUniqueId, omit, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger" | "quiet-danger" | "icon";
  size?: "sm";
};
export function Button(props: ButtonProps) {
  return <button {...omit(props, "variant", "size", "class")} type={props.type || "button"} class={`btn btn-${props.variant || "primary"} ${props.size === "sm" ? "btn-sm" : ""} ${props.class || ""}`} />;
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
  return <label class={`field ${props.class || ""}`} for={id()}><span>{props.label}</span>
    <select {...omit(props, "label", "hint", "error", "class")} id={id()} aria-invalid={props.error ? "true" : undefined} aria-describedby={descriptionId(id(), props)} />
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
export function Checkbox(props: JSX.InputHTMLAttributes<HTMLInputElement> & { label: string; indeterminate?: boolean }) {
  return <label class={`checkbox ${props.class || ""}`}><input {...omit(props, "label", "class", "indeterminate")} type="checkbox" prop:indeterminate={Boolean(props.indeterminate)} aria-checked={props.indeterminate ? "mixed" : props["aria-checked"]} /><span>{props.label}</span></label>;
}
export function Chip(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; variant?: "filter" }) {
  return <button {...omit(props, "selected", "variant", "class")} type={props.type || "button"} class={`${props.variant === "filter" ? "text-filter" : "chip"} ${props.selected ? "is-selected" : ""} ${props.class || ""}`} aria-pressed={props.selected ? "true" : "false"} />;
}
export function Tag(props: { children: JSX.Element; tone?: "neutral" | "ok" | "pending" | "failed"; class?: string }) {
  return <span class={`tag tag-${props.tone || "neutral"} ${props.class || ""}`}>{props.children}</span>;
}
