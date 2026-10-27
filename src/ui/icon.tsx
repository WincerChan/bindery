import { iconBodies, type IconName } from "./icon-data";

const svgAttributes = { focusable: "false" };

export type { IconName } from "./icon-data";

/** One Tabler-backed icon: decorative by default, named only when it carries meaning. */
export function Icon(props: { name: IconName; size?: number; strokeWidth?: number; class?: string; label?: string }) {
  return <svg viewBox="0 0 24 24" width={props.size ?? 20} height={props.size ?? 20}
    {...svgAttributes} fill="none" stroke-width={props.strokeWidth ?? 1.7} class={props.class}
    role={props.label ? "img" : undefined} aria-label={props.label}
    aria-hidden={props.label ? undefined : "true"} innerHTML={iconBodies[props.name]} />;
}
