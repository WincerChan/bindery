import type { IconName } from "../ui/icon";

export const navigation = [
  { href: "/", label: "书库", icon: "books" },
  { href: "/ingest", label: "入库", icon: "upload" },
  { href: "/tracker", label: "追踪", icon: "bookmark" },
  { href: "/vocabulary", label: "生词本", icon: "vocabulary" },
  { href: "/devices", label: "设备", icon: "device-tablet" },
] as const satisfies readonly { href: string; label: string; icon: IconName }[];
export const settingsLink = { href: "/settings", label: "设置", icon: "settings" } as const satisfies { href: string; label: string; icon: IconName };
export const phoneNavigation = [...navigation.filter(item => item.href !== "/devices"), settingsLink];

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
export function navActive(path: string, href: string): boolean {
  path = path.split(/[?#]/, 1)[0]!.replace(/\/+$/, "") || "/";
  if (href === "/") return path === "/" || within(path, "/book") || within(path, "/books") || within(path, "/archive");
  if (href === "/ingest") return within(path, href) || within(path, "/jobs");
  if (href === "/tracker") return within(path, href) || within(path, "/wishlist");
  if (href === "/vocabulary") return within(path, href) || within(path, "/devices/vocabulary");
  if (href === "/settings") return [href, "/rules", "/themes", "/security"].some(root => within(path, root));
  if (href === "/devices") return !within(path, "/devices/vocabulary") && (within(path, href) || within(path, "/kindle"));
  return within(path, href);
}
