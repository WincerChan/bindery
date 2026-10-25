import { createSignal, For, onSettled, Show } from "solid-js";
import { useDevice } from "./context";
import { agoLabel, bytes } from "./format";
import { kindleModelInfo, koboModelInfo, modelShortName } from "../../client/devices/models";
import { Button } from "../../ui";
import { Link } from "../../shared/spa-link";
import { KindleIcon } from "../kindle/icons";

export function DeviceBar() {
  const k = useDevice(), [now, setNow] = createSignal(0);
  let details: HTMLDetailsElement | undefined;
  onSettled(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const closeOutside = (event: PointerEvent) => { if (details?.open && !details.contains(event.target as Node)) details.open = false; };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !details?.open) return;
      details.open = false; details.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside); document.addEventListener("keydown", closeEscape);
    return () => { clearInterval(timer); document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  });
  const status = () => !k.ready() ? "检测中…" : !k.supported() ? "此浏览器不支持设备磁盘访问" : ({ granted: "已连接", prompt: "已插入 · 需要授权", denied: "已拒绝", disconnected: "已断开", unpaired: k.state().checkedAt ? "待完成配对" : "未配对或未选择设备" })[k.state().status];
  const usage = () => k.inventory()?.usage;
  // A disconnected device says when it was last seen; a connected one needs no timestamp.
  const lastSeen = () => k.ready() && k.state().status === "disconnected" && k.state().checkedAt !== null ? ` · ${agoLabel(k.state().checkedAt!, now())}识别` : "";
  const device = () => k.ready() ? k.state().device : null;
  const info = () => { const current = device(); return current ? (current.identity.kind === "kindle" ? kindleModelInfo : koboModelInfo)(current.identity.model) : null; };
  const spec = () => {
    const current = device(), model = info();
    if (!current || !model) return "通过 USB 连接设备并选择设备根目录";
    // Kindle's version.txt reads "Kindle 5.16.2.1.1 (…)": the version number is what matters.
    const firmware = current.firmware ? /\d+(?:\.\d+)+/.exec(current.firmware)?.[0] ?? current.firmware : "";
    // The heading already shows the name; repeat the model only when it differs.
    return [current.identity.name.trim() === model.name ? "" : model.name, model.inches ? `${model.inches}″` : "", firmware ? `固件 ${firmware}` : ""].filter(Boolean).join(" · ");
  };
  const specDetail = () => { const model = info(); return model?.width ? `${model.width}×${model.height} · ${model.ppi} ppi` : undefined; };
  const width = (n: number) => `${usage()?.total ? n / usage()!.total * 100 : 0}%`;
  const currentId = () => k.state().device?.identity.id ?? "";
  const savedStatus = (saved: { id: string }) => {
    if (saved.id === currentId() && k.state().checkedAt !== null) return ({ granted: "已连接", prompt: "需要授权", denied: "已拒绝", disconnected: "未连接", unpaired: "待配对" })[k.state().status];
    const permission = k.permissions()[saved.id] ?? "prompt";
    if (permission !== "granted") return permission === "denied" ? "已拒绝" : "需要授权";
    return k.connections()[saved.id] ? "已连接" : "未连接";
  };
  return <section aria-label="当前设备" class="kindle-device-bar" data-kindle-device-bar>
    <div class="kindle-device-identity">
      <div class="kindle-device-name">
        <span aria-hidden="true" title={`${status()}${lastSeen()}`} class={`kindle-dot ${k.ready() && k.state().status === "granted" ? "connected" : ""}`} />
        <h1 class="page-title">{k.ready() && k.state().device ? k.state().device!.identity.name : "设备"}</h1>
        <details ref={details} class="kindle-device-details">
          <summary aria-label="查看设备规格" title="设备规格"><KindleIcon name="info" /></summary>
          <div class="kindle-device-spec-popover">
            <p class="kindle-small kindle-device-spec" title={specDetail()}>{spec()}</p>
            <Show when={specDetail()}><p class="kindle-small kindle-mono">{specDetail()}</p></Show>
          </div>
        </details>
      </div>
      <span class="sr-only kindle-status" role="status">{status()}{lastSeen()}</span>
      <Show when={k.ready() && !k.supported()}><p class="kindle-small">请在 Windows 的 Edge 或 Chrome 桌面版中通过 HTTPS 或 localhost 打开。</p></Show>
      <Show when={k.ready() && k.state().status === "denied"}><p class="kindle-small">点击授权重试，或在地址栏的站点设置中恢复文件访问权限，再重新选择设备目录。</p></Show>
      <Show when={k.ready() && k.state().message && k.state().status !== "disconnected"}><p class="kindle-small">{k.state().message}</p></Show>
      <Show when={k.syncError()}><p class="field-error" role="alert" data-reading-sync>{k.syncError()}</p></Show>
      <Show when={k.syncSummary()}><p class="kindle-small" role="status" data-reading-sync>{k.syncSummary()}</p></Show>
    </div>
    <Show when={k.ready() && k.state().status === "granted"}>
      <div class="kindle-usage" aria-busy={k.inventoryBusy() ? "true" : "false"}>
        <p class="kindle-small">已枚举文件 <span class="kindle-mono">{usage() ? bytes(usage()!.total) : k.inventoryBusy() ? "读取中…" : "未读取"}</span></p>
        <Show when={usage()}><div class="kindle-usage-bar" role="img" aria-label={`书籍 ${bytes(usage()!.books)}，字体 ${bytes(usage()!.fonts)}，其他 ${bytes(usage()!.other)}`}>
          <span class="books" style={{ width: width(usage()!.books) }} /><span class="fonts" style={{ width: width(usage()!.fonts) }} /><span class="other" style={{ width: width(usage()!.other) }} />
        </div><p class="kindle-small kindle-mono">书籍 {bytes(usage()!.books)} · 字体 {bytes(usage()!.fonts)} · 其他 {bytes(usage()!.other)}</p></Show>
      </div>
    </Show>
    <div class="kindle-actions kindle-device-actions">
      <Show when={k.ready()}>
        <label class="kindle-device-switch"><span class="sr-only">切换当前设备</span>
          <select aria-label="切换当前设备" value={currentId()} disabled={!k.supported() || k.busy() || !k.remembered().length} onChange={event => {
            const id = event.currentTarget.value, select = event.currentTarget;
            if (!id || id === currentId()) return;
            void k.switchDevice(id).finally(() => { select.value = currentId(); });
          }}>
            <option value="">{k.remembered().length ? "当前设备" : "尚未记住设备"}</option>
            {/* The owner's name tells devices apart; the model is in the status line above. */}
            <For each={k.remembered()}>{saved => <option value={saved.id}>{saved.identity.name.trim() || modelShortName(saved.identity.kind, saved.identity.model)} · {savedStatus(saved)}</option>}</For>
          </select>
        </label>
      </Show>
      <Show when={k.ready() && k.supported()}>
        <Show when={k.state().status === "prompt" || k.state().status === "denied"}><Button disabled={k.busy()} onClick={() => k.authorize()}>授权</Button></Show>
        <Button variant="quiet" disabled={k.busy()} onClick={k.refresh}>重新检测</Button>
      </Show>
      <Link class="btn btn-secondary" href="/devices/connect">连接新设备</Link>
    </div>
    <Show when={k.inventory()?.unreadableCount}>
      <details class="kindle-small kindle-full kindle-entry-notice" data-unreadable-notice>
        <summary>有 {k.inventory()!.unreadableCount} 个条目无法读取（路径超过 Windows 260 字符限制等），已跳过统计</summary>
        <ul><For each={k.inventory()!.unreadable}>{entry => <li><span class="kindle-mono">{entry.path}</span>（{entry.reason}；{entry.likelyCause}；Windows 路径 {entry.windowsPathLength} 字符）</li>}</For></ul>
      </details>
    </Show>
    <Show when={k.error() || k.inventoryError()}><p class="field-error kindle-full" role="alert">{k.error() || k.inventoryError()}</p></Show>
  </section>;
}
export const KindleDeviceBar = DeviceBar;
