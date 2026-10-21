import { createSignal, For, Show } from "solid-js";
import { KINDLE_MODELS, type KindleModel } from "../../client/devices/models";
import { Button, TextField } from "../../ui";
import { Link } from "../../shared/spa-link";
import { useDevice } from "./context";
import { kindLabel, modelLabel } from "./format";
import { KindleIcon } from "../kindle/icons";

export function DeviceConnectPage() {
  const k = useDevice(), [model, setModel] = createSignal<KindleModel>("KPW3"), [name, setName] = createSignal("");
  const detection = () => k.state().detected, kind = () => k.kind();
  const canPair = () => k.ready() && k.state().status === "unpaired" && k.state().checkedAt !== null && !!detection();
  const defaultName = () => detection() ? modelLabel(kind(), detection()!.model).split(" · ")[0]! : "我的设备";
  return <div class="kindle-split kindle-connect">
    <section aria-label="连接设备">
      <div class="kindle-connect-heading">
        <h1>连接你的设备</h1>
        <p class="muted">用 USB 线连上电脑后，在浏览器里选中设备根目录。Kindle 的书写入 documents/、封面写入 system/thumbnails/；Kobo 的书写入 Bindery/；字体都写入 fonts/。设备身份保存在 .bindery/。</p>
      </div>
      <ol class="kindle-steps">
        <li><strong>用 USB 线连接设备</strong><p>Kindle 与 Kobo 都会作为 USB 磁盘出现，请保持连接。</p></li>
        <li><strong>选中设备磁盘的根目录</strong><p>Kindle 根目录能看到 documents 和 system；Kobo 根目录能看到 .kobo 文件夹。</p></li>
        <li><strong>在浏览器弹窗里允许编辑</strong><p>浏览器重启后再次授权时会提供「每次访问都允许」选项。</p></li>
        <li><strong>第一次连接：确认型号并命名</strong><p>Bindery 会写入 .bindery/device.json，之后用它识别这台设备。</p>
          <Show when={detection()}>
            <p class="kindle-small" data-detected-device>已识别：{kindLabel(kind())} · {modelLabel(kind(), detection()!.model)}{detection()!.productId ? ` · 产品 ID ${detection()!.productId}` : ""}</p>
          </Show>
          <Show when={kind() === "kindle"}>
            <fieldset class="kindle-model-choice" disabled={!k.ready() || !k.supported() || k.busy()}><legend>Kindle 型号</legend><div class="kindle-models" role="radiogroup" aria-label="型号"><For each={["KPW3", "KO3", "other"] as const}>{value => <label class="checkbox"><input type="radio" name="kindle-model" value={value} checked={model() === value} onChange={() => setModel(value)} />{KINDLE_MODELS[value].name}</label>}</For></div></fieldset>
          </Show>
          <Show when={canPair()}>
            <form class="kindle-pair form-stack" onSubmit={e => { e.preventDefault(); void k.run(async () => { const selected = kind() === "kobo" ? detection()!.model : model(); await k.manager.pair(selected, name().trim() || defaultName()); await k.loadRemembered(); }); }}>
              <h2>完成首次配对</h2>
              <TextField label="显示名称" placeholder={kind() === "kobo" ? "例如：我的 Libra 2" : "例如：我的 Paperwhite"} maxlength={100} value={name()} onInput={e => setName(e.currentTarget.value)} />
              <Button type="submit" disabled={k.busy()}>保存并配对</Button>
            </form>
          </Show>
        </li>
      </ol>
      <div class="kindle-actions"><Button disabled={!k.ready() || !k.supported() || k.busy()} onClick={k.pick}>选择设备目录</Button><span class="kindle-small">需要 Chrome 或 Edge 桌面版</span></div>
      <Show when={k.ready() && k.state().status === "granted"}><p class="notice">已连接 {k.state().device?.identity.name}。<Link href="/devices">查看设备书籍</Link>，或<Link href="/devices/transfer">从书库传书</Link>。</p></Show>
    </section>
    <aside aria-label="记住的设备" class="kindle-aside">
      <h2>记住的设备</h2>
      <p class="kindle-small kindle-connect-status" role="status">{!k.ready() ? "检测中…" : !k.supported() ? "此浏览器不支持设备磁盘访问，请使用 Edge 或 Chrome 桌面版。" : k.state().status === "granted" ? `已连接 ${k.state().device?.identity.name}` : k.state().status === "denied" ? "已拒绝授权，请在地址栏的站点设置中恢复文件访问权限。" : "未连接设备"}</p>
      <Show when={k.error() || k.state().message}><p class="field-error" role="alert">{k.error() || k.state().message}</p></Show>
      <Show when={k.ready()}>
        <For each={k.remembered()} fallback={<p class="muted">尚未记住设备。首次配对后会保存在此浏览器中。</p>}>{saved => <div class="kindle-remembered" data-remembered-device={saved.id}>
          <KindleIcon name="device" />
          <div class="kindle-remembered-info"><strong>{saved.identity.name}</strong><p class="kindle-small kindle-mono">{modelLabel(saved.identity.kind, saved.identity.model)}</p><p class="kindle-small">{k.state().device?.identity.id === saved.id ? ({ granted: "已连接", disconnected: "已断开", prompt: "需要授权", denied: "已拒绝", unpaired: "待配对" })[k.state().status] : ({ granted: "已记住 · 权限已授予", prompt: "需要授权", denied: "已拒绝" })[k.permissions()[saved.id] || "prompt"]}</p></div>
          <div class="kindle-actions"><Button variant="secondary" size="sm" disabled={k.busy() || !k.supported()} onClick={() => k.authorize(saved)}>{k.state().device?.identity.id === saved.id && k.state().status === "granted" ? "重新检测" : "授权 / 选择"}</Button><Button variant="quiet" size="sm" disabled={k.busy()} onClick={() => k.forget(saved.id)}>忘记</Button></div>
        </div>}</For>
      </Show>
      <p class="kindle-small">每台设备分别记住排版方案。忘记设备仅删除此浏览器中的记录，不删除设备上的书籍或身份。</p>
      <p class="kindle-small">网页收不到插拔通知；页面可见时每 1.5 秒、重新获得焦点时自动检测。</p>
    </aside>
  </div>;
}
export const KindleConnectPage = DeviceConnectPage;
