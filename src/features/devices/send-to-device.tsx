import { createSignal, Show } from "solid-js";
import type { TransferRequestOptions } from "../../client/devices";
import { Button } from "../../ui";
import { Link } from "../../shared/spa-link";
import { useOptionalDevice } from "./context";

/**
 * Sends the previewed book to the current device with the preview's own settings, replacing an earlier
 * copy. `blocked` explains why the current settings cannot be sent (e.g. an unsaved Kindle profile).
 */
export function SendToDevice(props: { bookId: string; profileId: string; options: TransferRequestOptions; blocked?: string }) {
  const k = useOptionalDevice();
  const [queued, setQueued] = createSignal<string | null>(null);
  const device = () => k?.ready() && k.state().status === "granted" ? k.state().device : null;
  const reason = () => !k?.ready() ? "正在检测设备…" : !device() ? "连接设备后可直接发送。" : !props.bookId ? "先选择一本书。" : props.blocked ?? "";
  const item = () => { const id = queued(); return id ? k?.items().find(entry => entry.id === id) : undefined; };
  function send() {
    if (!k || reason()) return;
    void k.run(async () => { setQueued(k.enqueue(props.bookId, props.profileId, { ...props.options, overwrite: true })); });
  }
  return <Show when={k}><div class="kt-send" data-send-to-device>
    <Button class="kt-send-button" disabled={Boolean(reason()) || k!.busy()} onClick={send}>{device() ? `发送到 ${device()!.identity.name}` : "发送到设备"}</Button>
    <Show when={reason()}><p class="kindle-small">{reason()}</p></Show>
    <Show when={item()}>{entry => <p class="kindle-small" role="status">{entry().state === "完成" || entry().state === "失败" ? `${entry().state}：${entry().message}` : `${entry().state}中…`} · <Link href="/devices/transfer">查看队列</Link></p>}</Show>
  </div></Show>;
}
