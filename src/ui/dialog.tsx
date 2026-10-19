import { createEffect, createSignal, createUniqueId, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "./controls";
import { showToast } from "../client/toast";

export function Dialog(props: { open: boolean; title: string; children: JSX.Element; onClose: () => void; class?: string; closeLabel?: string; id?: string }) {
  let element!: HTMLDialogElement;
  const titleId = createUniqueId();
  createEffect(() => props.open, open => {
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  });
  return <dialog ref={element} id={props.id} class={`dialog ${props.class || ""}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); props.onClose(); }}
    onClose={() => { if (props.open) props.onClose(); }}
    onClick={event => { if (event.target === element) { const box = element.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) props.onClose(); } }}>
    <div class="dialog-heading"><h2 id={titleId}>{props.title}</h2><Button variant="quiet" onClick={props.onClose} aria-label={props.closeLabel || "关闭对话框"}>×</Button></div>
    {props.children}
  </dialog>;
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
