export const navigation = [
  { href: "/", label: "书库" },
  { href: "/ingest", label: "入库" },
  { href: "/jobs", label: "任务" },
  { href: "/tracker", label: "追踪" },
  { href: "/rules", label: "规则" },
  { href: "/archive", label: "归档" },
  { href: "/kindle", label: "Kindle" },
  { href: "/security", label: "安全" },
] as const;
export function navActive(path: string, href: string): boolean {
  if (href === "/") return path === "/" || path.startsWith("/book");
  if (href === "/tracker") return path.startsWith("/tracker") || path.startsWith("/wishlist");
  return path.startsWith(href);
}
