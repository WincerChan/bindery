import { createSignal, For, Show } from "solid-js";
import { type KindleModel } from "../../../client/kindle";
import { Button, TextField } from "../../../ui";
import { Link } from "../../../shared/spa-link";
import { useKindle } from "../context";
import { modelLabel } from "./format";
import { KindleIcon } from "../icons";

export function KindleConnectPage() {
  const k = useKindle(), [model, setModel] = createSignal<KindleModel>("KPW3"), [name, setName] = createSignal("");
  const canPair = () => k.ready() && k.state().status === "unpaired" && k.state().checkedAt !== null;
  return <div class="kindle-split kindle-connect">
    <section aria-label="连接 Kindle">
      <div class="kindle-connect-heading">
        <h1>连接你的 Kindle</h1>
        <p class="muted">用 USB 线连上电脑后，在浏览器里选中 Kindle 的根目录。书籍写入 documents/，字体写入 fonts/，封面写入 system/thumbnails/，设备身份与传输记录保存在 .bindery/。</p>
      </div>
      <ol class="kindle-steps">
        <li><strong>用 USB 线连接 Kindle</strong><p>KPW3、KO3 会作为 USB 磁盘出现，请保持连接。</p></li>
        <li><strong>选中 Kindle 磁盘的根目录</strong><p>根目录里能看到 documents 和 system 两个文件夹。</p></li>
        <li><strong>在浏览器弹窗里允许编辑</strong><p>浏览器重启后再次授权时会提供「每次访问都允许」选项。</p></li>
        <li><strong>第一次连接：选择型号并命名</strong><p>Bindery 会写入 .bindery/device.json，之后用它识别这台 Kindle。</p>
          <fieldset class="kindle-model-choice" disabled={!k.ready() || !k.supported() || k.busy()}><legend>Kindle 型号</legend><div class="kindle-models" role="radiogroup" aria-label="型号"><For each={["KPW3", "KO3", "other"] as const}>{value => <label class="checkbox"><input type="radio" name="kindle-model" value={value} checked={model() === value} onChange={() => setModel(value)} />{modelLabel(value).split(" · ")[0]}</label>}</For></div></fieldset>
          <Show when={canPair()}>
            <form class="kindle-pair form-stack" onSubmit={e => { e.preventDefault(); void k.run(async () => { await k.manager.pair(model(), name().trim() || modelLabel(model()).split(" · ")[0]!); await k.loadRemembered(); }); }}>
              <h2>完成首次配对</h2>
              <TextField label="显示名称" placeholder="例如：我的 Paperwhite" maxlength={100} value={name()} onInput={e => setName(e.currentTarget.value)} />
              <Button type="submit" disabled={k.busy()}>保存并配对</Button>
            </form>
          </Show>
        </li>
      </ol>
      <div class="kindle-actions"><Button disabled={!k.ready() || !k.supported() || k.busy()} onClick={k.pick}>选择 Kindle 目录</Button><span class="kindle-small">需要 Chrome 或 Edge 桌面版</span></div>
      <Show when={k.ready() && k.state().status === "granted"}><p class="notice">已连接 {k.state().device?.identity.name}。<Link href="/kindle">查看设备书籍</Link>，或<Link href="/kindle/transfer">从书库传书</Link>。</p></Show>
    </section>
    <aside aria-label="记住的设备" class="kindle-aside">
      <h2>记住的设备</h2>
      <p class="kindle-small kindle-connect-status" role="status">{!k.ready() ? "检测中…" : !k.supported() ? "此浏览器不支持 Kindle 磁盘访问，请使用 Edge 或 Chrome 桌面版。" : k.state().status === "granted" ? `已连接 ${k.state().device?.identity.name}` : k.state().status === "denied" ? "已拒绝授权，请在地址栏的站点设置中恢复文件访问权限。" : "未连接设备"}</p>
      <Show when={k.error() || k.state().message}><p class="field-error" role="alert">{k.error() || k.state().message}</p></Show>
      <Show when={k.ready()}>
        <For each={k.remembered()} fallback={<p class="muted">尚未记住设备。首次配对后会保存在此浏览器中。</p>}>{saved => <div class="kindle-remembered" data-remembered-device={saved.id}>
          <KindleIcon name="device" />
          <div class="kindle-remembered-info"><strong>{saved.identity.name}</strong><p class="kindle-small kindle-mono">{modelLabel(saved.identity.model)}</p><p class="kindle-small">{k.state().device?.identity.id === saved.id ? ({ granted: "已连接", disconnected: "已断开", prompt: "需要授权", denied: "已拒绝", unpaired: "待配对" })[k.state().status] : ({ granted: "已记住 · 权限已授予", prompt: "需要授权", denied: "已拒绝" })[k.permissions()[saved.id] || "prompt"]}</p></div>
          <div class="kindle-actions"><Button variant="secondary" size="sm" disabled={k.busy() || !k.supported()} onClick={() => k.authorize(saved)}>{k.state().device?.identity.id === saved.id && k.state().status === "granted" ? "重新检测" : "授权 / 选择"}</Button><Button variant="quiet" size="sm" disabled={k.busy()} onClick={() => k.forget(saved.id)}>忘记</Button></div>
        </div>}</For>
      </Show>
      <p class="kindle-small">每台设备分别记住排版方案。忘记设备仅删除此浏览器中的记录，不删除 Kindle 上的书籍或身份。</p>
      <p class="kindle-small">网页收不到插拔通知；页面可见时每 1.5 秒、重新获得焦点时自动检测。</p>
    </aside>
  </div>;
}
