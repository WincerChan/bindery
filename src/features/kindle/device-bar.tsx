import { createSignal, For, onSettled, Show } from "solid-js";
import { useKindle } from "./context";
import { bytes, modelLabel } from "./devices/format";
import { Button } from "../../ui";

export function KindleDeviceBar() {
  const k = useKindle(), [now, setNow] = createSignal(0);
  onSettled(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); });
  const status = () => !k.ready() ? "检测中…" : !k.supported() ? "此浏览器不支持 Kindle 磁盘访问" : ({ granted: "已连接", prompt: "已插入 · 需要授权", denied: "已拒绝", disconnected: "已断开", unpaired: k.state().checkedAt ? "待完成配对" : "未配对或未选择设备" })[k.state().status];
  const usage = () => k.inventory()?.usage;
  const ago = () => k.state().checkedAt === null ? "尚未检测" : `检测于 ${Math.max(0, Math.floor((now() - k.state().checkedAt!) / 1000))} 秒前`;
  const width = (n: number) => `${usage()?.total ? n / usage()!.total * 100 : 0}%`;
  return <section aria-label="当前设备" class="kindle-device-bar" data-kindle-device-bar>
    <div class="kindle-device-identity">
      <p class={`kindle-status ${k.ready() && k.state().status === "granted" ? "is-connected" : ""}`} role="status"><span aria-hidden="true" class={`kindle-dot ${k.ready() && k.state().status === "granted" ? "connected" : ""}`} />{status()}<Show when={k.ready() && k.state().checkedAt !== null}><span>· {k.state().status === "disconnected" ? "最后成功识别：" : ""}{ago()}</span></Show></p>
      <h1>{k.ready() && k.state().device ? k.state().device!.identity.name : "Kindle"}</h1>
      <p class="kindle-device-meta kindle-mono">{k.ready() && k.state().device ? `${modelLabel(k.state().device!.identity.model)} · 固件 ${k.state().device!.firmware || "未读取"} · 由 .bindery/device.json 识别` : "通过 USB 连接设备并选择 Kindle 根目录"}</p>
      <Show when={k.ready() && !k.supported()}><p class="kindle-small">请在 Windows 的 Edge 或 Chrome 桌面版中通过 HTTPS 或 localhost 打开。</p></Show>
      <Show when={k.ready() && k.state().status === "denied"}><p class="kindle-small">点击授权重试，或在地址栏的站点设置中恢复文件访问权限，再重新选择 Kindle 目录。</p></Show>
      <Show when={k.ready() && k.state().message}><p class="kindle-small">{k.state().message}</p></Show>
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
      <Show when={k.ready() && k.supported()}>
        <Show when={k.state().status === "prompt" || k.state().status === "denied"}><Button disabled={k.busy()} onClick={() => k.authorize()}>授权</Button></Show>
        <Button variant="quiet" disabled={k.busy()} onClick={k.refresh}>重新检测</Button>
      </Show>
      <a class="btn btn-secondary" href="/kindle/connect">{k.state().device ? "切换设备" : "连接 Kindle"}</a>
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
