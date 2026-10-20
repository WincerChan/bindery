export const gearIcon = "M9 2h6l.5 3L17 6l3-1 3 5-2.5 2v1l2.5 2-3 5-3-1-1.5 1-.5 3H9l-.5-3L7 19l-3 1-3-5 2.5-2v-1L1 10l3-5 3 1 1.5-1z";
export const navigation = [
  { href: "/", label: "书库", icon: "M4 4h4v16H4zM10 4h4v16h-4zM17 5l3-.7 3 15-3 .7z" },
  { href: "/ingest", label: "入库", icon: "M12 15V4M7 9l5-5 5 5M4 15v5h16v-5" },
  { href: "/tracker", label: "追踪", icon: "M6 3h12v18l-6-4-6 4z" },
  { href: "/kindle", label: "设备", icon: "M6 3h12v18H6zM10 18h4" },
] as const;
export const settings = [
  { href: "/rules", label: "规则与主题" },
  { href: "/security", label: "安全与通行密钥" },
] as const;
export function navActive(path: string, href: string): boolean {
  if (href === "/") return path === "/" || path.startsWith("/book");
  if (href === "/tracker") return path.startsWith("/tracker") || path.startsWith("/wishlist");
  if (href === "/rules") return path.startsWith("/rules") || path.startsWith("/themes");
  return path.startsWith(href);
}
