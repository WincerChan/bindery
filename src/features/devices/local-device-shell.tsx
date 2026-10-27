import type { JSX } from "@solidjs/web";
import type { DeviceKind } from "../../client/devices/models";

/** Design §5.2: only models with physical side grips get the wider shell. */
export function hasSideGrip(kind: DeviceKind, model: string) {
  return kind === "kindle" ? model === "KO3" : ["libra2", "libraH2O", "libraColour", "sage", "forma"].includes(model);
}
export function LocalDeviceShell(props: { kind: DeviceKind; model: string; idle?: boolean; compact?: boolean; children?: JSX.Element }) {
  return <div aria-hidden={props.compact ? "true" : undefined} class={`device-shell ${hasSideGrip(props.kind, props.model) ? "device-shell-grip" : ""} ${props.idle ? "device-shell-idle" : ""} ${props.compact ? "device-shell-compact" : ""}`}>
    <div class="device-shell-paper">{props.children}</div>
  </div>;
}
