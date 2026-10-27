export const gearIcon = "M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7";
export const vocabularyIcon = "M3.5 18l4.5-12 4.5 12M5.2 13.5h5.6M15 8h5.5M15 12h5.5M15 16h4";
export const navigation = [
  { href: "/", label: "书库", icon: "M4 4h4v16H4zM10 4h4v16h-4zM17 5l3-.7 3 15-3 .7z" },
  { href: "/ingest", label: "入库", icon: "M12 15V4M7 9l5-5 5 5M4 15v5h16v-5" },
  { href: "/tracker", label: "追踪", icon: "M6 3h12v18l-6-4-6 4z" },
  { href: "/vocabulary", label: "生词本", icon: vocabularyIcon },
  { href: "/devices", label: "设备", icon: "M6 3h12v18H6zM10 18h4" },
] as const;
export const settingsLink = { href: "/settings", label: "设置", icon: gearIcon } as const;
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
