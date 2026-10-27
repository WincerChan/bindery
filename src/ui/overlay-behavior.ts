/** Shared native-dialog behavior, also usable by render tests without a layout engine. */
export type OverlayVariant = "dialog" | "sheet" | "menu" | "popover";
export function overlayPresentation(variant: OverlayVariant, phone: boolean) {
  return phone ? (variant === "dialog" ? "page" : "bottom-sheet") : variant;
}
export function focusableElements(element: HTMLElement): HTMLElement[] {
  return Array.from(element.getElementsByTagName("*")).filter((node): node is HTMLElement => {
    const control = /^(button|input|select|textarea)$/i.test(node.tagName) || (node.tagName.toLowerCase() === "a" && node.hasAttribute("href"));
    return (control || node.hasAttribute("tabindex")) && !node.hasAttribute("disabled") && node.getAttribute("tabindex") !== "-1"
      && !node.hasAttribute("hidden") && (!node.closest || !node.closest('[hidden], [inert]'))
      && node.ownerDocument.defaultView?.getComputedStyle(node).visibility !== "hidden"
      && (!node.getClientRects || node.getClientRects().length > 0);
  });
}
export function overlayKeydown(event: KeyboardEvent, element: HTMLElement, close: () => void, menu = false, trap = true) {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation?.(); close(); return; }
  const targets = focusableElements(element), active = element.ownerDocument.activeElement;
  if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    const items = targets.filter(item => item.getAttribute("role") === "menuitem");
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(active as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index < 0 ? items.length - 1 : (index + items.length - 1) % items.length);
    items[next]?.focus();
  }
  if (event.key !== "Tab" || !trap) return;
  const first = targets[0], last = targets[targets.length - 1];
  if (!first) { event.preventDefault(); element.focus?.(); }
  else if (event.shiftKey && (active === first || !targets.includes(active as HTMLElement))) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && (active === last || !targets.includes(active as HTMLElement))) { event.preventDefault(); first.focus(); }
}
export function restoreOverlayFocus(target: Element | null) {
  if (target?.isConnected && "focus" in target) (target as HTMLElement).focus();
}
