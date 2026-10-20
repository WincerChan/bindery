import { useLocation } from "@tanstack/solid-router";
import { For } from "solid-js";
import { Link } from "../../shared/spa-link";

const TABS = [
  { href: "/kindle", label: "设备书籍" },
  { href: "/kindle/transfer", label: "传书" },
  { href: "/kindle/preview", label: "排版与预览" },
  { href: "/kindle/fonts", label: "字体" },
] as const;

export function KindleTabs() {
  const location = useLocation();
  const active = (href: string) => (href === "/kindle" ? location().pathname === "/kindle" || location().pathname === "/kindle/" : location().pathname.startsWith(href));
  return (
    <nav aria-label="Kindle 管理" class="kindle-tabs">
      <For each={TABS}>{tab => <Link href={tab.href} class={active(tab.href) ? "kindle-tab on" : "kindle-tab"} aria-current={active(tab.href) ? "page" : undefined}>{tab.label}</Link>}</For>
    </nav>
  );
}
