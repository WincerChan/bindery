import type { JSX } from "@solidjs/web";
import { PageTabs } from "../../ui";
import { useOptionalDevice } from "./context";

export function DeviceTabs(props: { value?: "books" | "fonts"; toolbar?: JSX.Element }) {
  const device = useOptionalDevice();
  return <div class="device-shelf-head"><PageTabs label="设备内容" value={props.value ?? "books"} tabs={[
    { value: "books", label: "书", href: "/devices", count: device?.inventory()?.books.length ?? 0 },
    { value: "fonts", label: "字体", href: "/devices/fonts", count: device?.inventory()?.fonts.length ?? 0 },
  ]} />{props.toolbar}</div>;
}
export const KindleTabs = DeviceTabs;
