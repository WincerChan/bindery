import { useLocation } from "@tanstack/solid-router";
import { PageTabs } from "../../ui";
import { useDevice } from "./context";

export function DeviceTabs() {
  const location = useLocation(), device = useDevice();
  return <PageTabs label="设备内容" value={location().pathname.endsWith("/fonts") ? "fonts" : "books"} tabs={[
    { value: "books", label: "书", href: "/devices", count: device.inventory()?.books.length ?? 0 },
    { value: "fonts", label: "字体", href: "/devices/fonts", count: device.inventory()?.fonts.length ?? 0 },
  ]} />;
}
export const KindleTabs = DeviceTabs;
