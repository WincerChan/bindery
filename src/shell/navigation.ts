import TablerBookmark from "~icons/tabler/bookmark";
import TablerBooks from "~icons/tabler/books";
import TablerDeviceTablet from "~icons/tabler/device-tablet";
import TablerSettings from "~icons/tabler/settings";
import TablerUpload from "~icons/tabler/upload";
import TablerVocabulary from "~icons/tabler/vocabulary";
import type { IconComponent } from "../ui/icon";

export const navigation = [
  { href: "/", label: "书库", icon: TablerBooks },
  { href: "/ingest", label: "入库", icon: TablerUpload },
  { href: "/tracker", label: "追踪", icon: TablerBookmark },
  { href: "/vocabulary", label: "生词本", icon: TablerVocabulary },
  { href: "/devices", label: "设备", icon: TablerDeviceTablet },
] as const satisfies readonly { href: string; label: string; icon: IconComponent }[];
export const settingsLink = { href: "/settings", label: "设置", icon: TablerSettings } as const satisfies { href: string; label: string; icon: IconComponent };
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
