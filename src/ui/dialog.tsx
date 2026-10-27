import { createEffect, createSignal, createUniqueId, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "./controls";
import { Link } from "../shared/spa-link";
import { showToast } from "../client/toast";
import { CloseButton } from "./primitives";
import { Icon } from "./icon";
import { focusableElements, overlayKeydown, overlayPresentation, restoreOverlayFocus } from "./overlay-behavior";
import type { OverlayVariant } from "./overlay-behavior";

export interface DialogProps {
  open: boolean; title: string; children: JSX.Element; onClose: () => void;
  class?: string; closeLabel?: string; id?: string; variant?: OverlayVariant;
  side?: "left" | "right"; subtitle?: string; actions?: JSX.Element;
  anchor?: () => HTMLElement | undefined;
}
export function Dialog(props: DialogProps) {
  let element!: HTMLDialogElement, previousFocus: Element | null = null;
  const titleId = createUniqueId(), subtitleId = createUniqueId();
  const [phone, setPhone] = createSignal(false);
  const variant = () => props.variant || "dialog";
  const modal = () => variant() !== "popover";
  function position() { untrack(() => {
    if (!props.open || phone() || !["menu", "popover"].includes(variant())) return;
    const anchor = props.anchor?.();
    if (!anchor) return;
    const box = anchor.getBoundingClientRect(), width = element.offsetWidth, height = element.offsetHeight;
    element.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(box.bottom + 8, window.innerHeight - height - 8))}px`;
  }); }
  onSettled(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(max-width: 767px)");
    const resize = () => { setPhone(query.matches); position(); };
    // Safari < 14 only implements the deprecated addListener/removeListener pair.
    const listen = (on: boolean) => typeof query.addEventListener === "function"
      ? on ? query.addEventListener("change", resize) : query.removeEventListener("change", resize)
      : on ? query.addListener?.(resize) : query.removeListener?.(resize);
    resize(); listen(true);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    const outside = (event: PointerEvent) => {
      if (props.open && !modal() && !element.contains(event.target as Node) && !props.anchor?.()?.contains(event.target as Node)) props.onClose();
    };
    document.addEventListener("pointerdown", outside);
    return () => { listen(false); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); document.removeEventListener("pointerdown", outside); };
  });
  createEffect(() => ({ open: props.open, phone: phone(), variant: variant() }), state => {
    if (state.open && !element.open) {
      previousFocus = element.ownerDocument.activeElement;
      if (state.variant !== "popover") element.showModal(); else element.show();
      const targets = focusableElements(element);
      const first = state.variant === "menu" ? targets.find(item => item.getAttribute("role") === "menuitem") : targets[0];
      first?.focus?.();
    } else if (!state.open && element.open) { element.close(); restoreOverlayFocus(previousFocus); previousFocus = null; }
    position();
  });
  onCleanup(() => { if (element?.open) { element.close(); restoreOverlayFocus(previousFocus); } });
  return <dialog ref={element} id={props.id} class={`dialog dialog-${variant()} ${props.side === "left" ? "dialog-left" : ""} ${props.class || ""}`} aria-modal={modal() ? "true" : undefined} aria-labelledby={titleId} aria-describedby={props.subtitle ? subtitleId : undefined} data-state={props.open ? "open" : "closed"} data-presentation={overlayPresentation(variant(), phone())}
    onKeyDown={event => overlayKeydown(event, element, props.onClose, variant() === "menu", modal())}
    onCancel={event => { event.preventDefault(); props.onClose(); }}
    onClose={() => { if (!element.open && props.open) props.onClose(); }}
    onClick={event => { if (event.target === element) { const box = element.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) props.onClose(); } }}>
    <div class="dialog-handle" aria-hidden="true" />
    <div class="dialog-heading"><div><h2 id={titleId}>{props.title}</h2><Show when={props.subtitle}><p id={subtitleId}>{props.subtitle}</p></Show></div><CloseButton onClick={props.onClose} aria-label={props.closeLabel || "关闭对话框"} /></div>
    <div class="dialog-body">{props.children}</div><Show when={props.actions}><div class="dialog-actions">{props.actions}</div></Show>
  </dialog>;
}
export function SideSheet(props: Omit<DialogProps, "variant">) { return <Dialog {...props} variant="sheet" />; }
export function CenterDialog(props: Omit<DialogProps, "variant">) { return <Dialog {...props} variant="dialog" />; }
export function Popover(props: Omit<DialogProps, "variant"> & { anchor: () => HTMLElement | undefined }) { return <Dialog {...props} variant="popover" />; }
type MenuItemBase = { label: string; destructive?: boolean; disabled?: boolean; separatorBefore?: boolean; class?: string };
export type MenuItem = MenuItemBase & (
  | { onSelect: () => unknown; href?: never; action?: never }
  | { href: string; native?: boolean; onSelect?: never; action?: never }
  | { action: string; fields?: Readonly<Record<string, string>>; onSubmit?: JSX.EventHandler<HTMLFormElement, SubmitEvent>; href?: never; onSelect?: never }
);
export function Menu(props: { title: string; trigger: JSX.Element; items: readonly MenuItem[]; subtitle?: string; status?: JSX.Element; statusTone?: "ok" | "accent" | "danger"; class?: string; dialogClass?: string }) {
  const [open, setOpen] = createSignal(false), [enhanced, setEnhanced] = createSignal(false);
  const id = createUniqueId();
  onSettled(() => { setEnhanced(true); });
  const close = () => setOpen(false);
  let trigger!: HTMLButtonElement;
  function Items(list: { native?: boolean }) {
    return <For each={[false, true]}>{destructive => <Show when={props.items.some(item => Boolean(item.destructive) === destructive)}>
      <Show when={destructive}><hr /></Show>
      <For each={props.items.filter(item => Boolean(item.destructive) === destructive)}>{item => {
        const role = () => list.native ? undefined : "menuitem";
        const itemClass = () => `${item.destructive ? "is-destructive" : ""} ${item.class || ""}`.trim() || undefined;
        return <><Show when={item.separatorBefore && !destructive}><hr /></Show>{
          item.href !== undefined
            ? <Show when={!item.disabled} fallback={<span role={role()} aria-disabled="true" class={itemClass()}>{item.label}</span>}>
              <Show when={!item.native} fallback={<a role={role()} class={itemClass()} href={item.href} onClick={close}>{item.label}</a>}>
                <Link role={role()} class={itemClass()} href={item.href} onClick={close}>{item.label}</Link>
              </Show>
            </Show>
            : item.action !== undefined
              ? <form action={item.action} method="post" onSubmit={event => { close(); item.onSubmit?.(event); }}>
                <For each={Object.entries(item.fields || {})}>{([name, value]) => <input type="hidden" name={name} value={value} />}</For>
                <button type="submit" role={role()} class={itemClass()} disabled={item.disabled}>{item.label}</button>
              </form>
              : <button type="button" role={role()} class={itemClass()} disabled={item.disabled || list.native} onClick={() => { close(); item.onSelect(); }}>{item.label}</button>
        }</>;
      }}</For>
    </Show>}</For>;
  }
  const status = () => <Show when={props.status}><div class={`ui-menu-status ui-menu-status-${props.statusTone || "accent"}`} role="status">{props.status}</div></Show>;
  return <div class={`ui-menu ${props.class || ""}`}><button ref={trigger} type="button" hidden={!enhanced()} class="ui-menu-trigger" aria-haspopup="menu" aria-expanded={open() ? "true" : "false"} aria-controls={id} onClick={() => setOpen(!open())} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>{props.trigger}<span class="ui-menu-chevron" aria-hidden="true"><Icon name="chevron-down" size={14} /></span></button>
    <Dialog id={id} open={open()} title={props.title} subtitle={props.subtitle} variant="menu" anchor={() => trigger} onClose={close} class={props.dialogClass}>
      {status()}<div role="menu" aria-label={props.title}><Items /></div>
    </Dialog>
    <Show when={!enhanced()}><details class="ui-menu-native"><summary aria-label={`《${props.title}》的操作`}>{props.trigger}</summary><Show when={props.subtitle}><p>{props.subtitle}</p></Show>{status()}<Items native /></details></Show>
  </div>;
}
export function ConfirmDialog(props: { open: boolean; title: string; children: JSX.Element; onClose: () => void; onConfirm: () => unknown | Promise<unknown>; confirmLabel?: string; danger?: boolean }) {
  const [busy, setBusy] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal("");
  async function confirm() {
    setBusy(true);
    setErrorMessage("");
    try { await props.onConfirm(); props.onClose(); }
    catch (error) { const message = error instanceof Error ? error.message : "操作失败，请重试"; setErrorMessage(message); showToast(message, "error"); }
    finally { setBusy(false); }
  }
  return <Dialog open={props.open} title={props.title} onClose={() => { if (!busy()) props.onClose(); }}>
    {props.children}<Show when={errorMessage()}><p role="alert" class="field-error">{errorMessage()}</p></Show><div class="dialog-actions"><Button variant="secondary" disabled={busy()} onClick={props.onClose}>取消</Button><Button variant={props.danger ? "danger" : "primary"} disabled={busy()} onClick={confirm}>{busy() ? "处理中…" : props.confirmLabel || "确认"}</Button></div>
  </Dialog>;
}
