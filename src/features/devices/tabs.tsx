import { useLocation } from "@tanstack/solid-router";
import { For } from "solid-js";
import { Link } from "../../shared/spa-link";

const TABS = [
  { href: "/devices", label: "设备书籍" },
  { href: "/devices/transfer", label: "传书" },
  { href: "/devices/preview", label: "排版与预览" },
  { href: "/devices/fonts", label: "字体" },
  { href: "/devices/vocabulary", label: "生词本" },
] as const;

export function DeviceTabs() {
  const location = useLocation();
  const active = (href: string) => (href === "/devices" ? location().pathname === "/devices" || location().pathname === "/devices/" : location().pathname.startsWith(href));
  return (
    <nav aria-label="设备管理" class="kindle-tabs">
      <For each={TABS}>{tab => <Link href={tab.href} class={active(tab.href) ? "kindle-tab on" : "kindle-tab"} aria-current={active(tab.href) ? "page" : undefined}>{tab.label}</Link>}</For>
    </nav>
  );
}
export const KindleTabs = DeviceTabs;
