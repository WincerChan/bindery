import type { Component } from "solid-js";
import { Dynamic, type JSX } from "@solidjs/web";

/** Props accepted by on-demand icon components imported from `~icons/tabler/*`. */
export type IconProps = JSX.SvgSVGAttributes<SVGSVGElement> & { focusable?: string };
export type IconComponent = Component<IconProps>;

/**
 * One Tabler-backed icon: decorative by default, named only when it carries meaning.
 * Pass the imported component, e.g. `<Icon icon={TablerBooks} />`; imports stay on demand
 * instead of going through a generated name map. Size defaults to 20 and stroke to 1.7.
 */
export function Icon(props: { icon: IconComponent; size?: number; strokeWidth?: number; class?: string; label?: string }) {
  return <Dynamic component={props.icon} viewBox="0 0 24 24" width={props.size ?? 20} height={props.size ?? 20}
    focusable="false" fill="none" stroke-width={props.strokeWidth ?? 1.7} class={props.class}
    role={props.label ? "img" : undefined} aria-label={props.label}
    aria-hidden={props.label ? undefined : "true"} />;
}
