import { createSignal, For, Show } from "solid-js";
import { KINDLE_MODELS, type KindleModel } from "../../client/devices/models";
import { BackLink, Button, PageIntro, SectionTitle, SegmentedControl, TextField } from "../../ui";
import { LocalDeviceShell } from "./local-device-shell";
import { Link } from "../../shared/spa-link";
import { useDevice } from "./context";
import { kindLabel, modelLabel } from "./format";

export function DeviceConnectPage() {
  const k = useDevice(), [model, setModel] = createSignal<KindleModel>("KPW3"), [name, setName] = createSignal("");
  // Pairing follows the root that was just picked, never the remembered current device.
  const detection = () => k.state().detected, kind = () => detection()?.kind ?? k.kind();
  const detectedKind = () => detection()?.kind;
  const canPair = () => k.ready() && k.state().status === "unpaired" && k.state().checkedAt !== null && !!detection();
  // Only a freshly picked, unpaired root needs the detected summary and the model choice.
  const pairing = () => k.ready() && k.state().status === "unpaired" && !!detection();
  const defaultName = () => detection() ? modelLabel(kind(), detection()!.model).split(" · ")[0]! : "我的设备";
  return <div class="kindle-split kindle-connect">
    <section aria-label="连接设备">
      <BackLink href="/devices">设备</BackLink>
      <PageIntro eyebrow="设备 · 未连接" title="把 Kindle 或 Kobo 用 USB 接上。" visual={<LocalDeviceShell kind={k.kind()} model={k.state().device?.identity.model ?? "KPW3"} idle><p>等待连接</p></LocalDeviceShell>} />
      <details class="kindle-connect-heading"><summary>连接与文件访问说明</summary>
        <Show when={detection()} fallback={<p class="muted">用 USB 线连上电脑后，在浏览器里选中设备根目录。Bindery 会根据根目录结构自动识别 Kindle 或 Kobo；设备身份保存在 .bindery/。</p>}>
          <Show when={detectedKind() === "kindle"} fallback={<p class="muted">Kobo 的书写入 Bindery/，字体写入 fonts/，设备身份保存在 .bindery/。只读取阅读进度，不会修改 KoboReader.sqlite。</p>}>
            <p class="muted">Kindle 的书写入 documents/、封面写入 system/thumbnails/，字体写入 fonts/，设备身份保存在 .bindery/。同步时只读取阅读位置；配对、传书与字体管理会写入相应目录。</p>
          </Show>
        </Show>
      </details>
      <ol class="kindle-steps">
        <li><strong>用 USB 线连接设备</strong><p>Kindle 与 Kobo 都会作为 USB 磁盘出现，请保持连接。</p></li>
        <li><strong>选中设备磁盘的根目录</strong>
          <Show when={detection()} fallback={<p>Kindle 根目录能看到 documents 和 system；Kobo 根目录能看到 .kobo 文件夹。</p>}>
            <Show when={detectedKind() === "kindle"} fallback={<p>根目录里能看到 .kobo 文件夹。</p>}><p>根目录里能看到 documents 和 system 两个文件夹。</p></Show>
          </Show>
        </li>
        <li><strong>在浏览器弹窗里允许编辑</strong><p>浏览器重启后再次授权时会提供「每次访问都允许」选项。</p></li>
        <Show when={pairing()}><li class="device-pairing-step"><strong>第一次连接：确认型号并命名</strong><p>Bindery 会写入 .bindery/device.json，之后用它识别这台设备。</p>
          <Show when={pairing()}>
            <p class="kindle-small" data-detected-device>已识别：{kindLabel(kind())} · {modelLabel(kind(), detection()!.model)}{detection()!.modelCode ? ` · 型号代码 ${detection()!.modelCode}` : ""}{detection()!.productUuid ? ` · 产品 UUID ${detection()!.productUuid}` : ""}</p>
          </Show>
          <Show when={pairing() && detectedKind() === "kindle"}>
            <SegmentedControl label="型号" value={model()} disabled={!k.ready() || !k.supported() || k.busy()} options={["KPW3", "KO3", "other"].map(value => ({ value, label: KINDLE_MODELS[value as KindleModel].name }))} onChange={value => setModel(value as KindleModel)} />
          </Show>
          <Show when={canPair()}>
            <form class="kindle-pair form-stack" onSubmit={e => { e.preventDefault(); void k.run(async () => { const selected = kind() === "kobo" ? detection()!.model : model(); await k.manager.pair(selected, name().trim() || defaultName()); await k.loadRemembered(); }); }}>
              <h2>完成首次配对</h2>
              <TextField label="显示名称" placeholder={kind() === "kobo" ? "例如：我的 Libra 2" : "例如：我的 Paperwhite"} maxlength={100} value={name()} onInput={e => setName(e.currentTarget.value)} />
              <Button type="submit" disabled={k.busy()}>保存并配对</Button>
            </form>
          </Show>
        </li></Show>
      </ol>
      <p class="kindle-small">还没连接？也可以先打开<Link href="/devices/preview">排版与预览</Link>，看看书库里的书。</p>
      <div class="kindle-actions"><Button disabled={!k.ready() || !k.supported() || k.busy()} onClick={k.pick}>选择设备目录</Button><span class="kindle-small">需要 Chrome 或 Edge 桌面版</span></div>
      <Show when={k.ready() && k.state().status === "granted"}><p class="notice">已连接 {k.state().device?.identity.name}。<Link href="/devices">查看设备书籍</Link>，或<Link href="/devices/transfer">从书库传书</Link>。</p></Show>
    </section>
    <aside aria-label="记住的设备" class="kindle-aside">
      <SectionTitle>记住的设备</SectionTitle>
      <p class="kindle-small kindle-connect-status" role="status">{!k.ready() ? "检测中…" : !k.supported() ? "此浏览器不支持设备磁盘访问，请使用 Edge 或 Chrome 桌面版。" : k.state().status === "granted" ? `已连接 ${k.state().device?.identity.name}` : k.state().status === "denied" ? "已拒绝授权，请在地址栏的站点设置中恢复文件访问权限。" : "未连接设备"}</p>
      <Show when={k.error() || k.state().message}><p class="field-error" role="alert">{k.error() || k.state().message}</p></Show>
      <Show when={k.ready()}><div class="kindle-remembered-list">
        <For each={k.remembered()} fallback={<p class="muted">尚未记住设备。首次配对后会保存在此浏览器中。</p>}>{saved => <div class="kindle-remembered" data-remembered-device={saved.id}>
          <LocalDeviceShell compact kind={saved.identity.kind} model={saved.identity.model} />
          <div class="kindle-remembered-info"><strong>{saved.identity.name}</strong><p class="kindle-small kindle-mono">{modelLabel(saved.identity.kind, saved.identity.model)}</p><p class="kindle-small">{k.state().device?.identity.id === saved.id ? ({ granted: "已连接", disconnected: "已断开", prompt: "需要授权", denied: "已拒绝", unpaired: "待配对" })[k.state().status] : ({ granted: "已记住 · 权限已授予", prompt: "需要授权", denied: "已拒绝" })[k.permissions()[saved.id] || "prompt"]}</p></div>
          <div class="kindle-actions"><Button variant="secondary" size="sm" disabled={k.busy() || !k.supported()} onClick={() => { if (k.state().device?.identity.id === saved.id && k.state().status === "granted") void k.refresh(); else void k.authorize(saved); }}>{k.state().device?.identity.id === saved.id && k.state().status === "granted" ? "重新检测" : "授权 / 选择"}</Button><Button variant="quiet" size="sm" disabled={k.busy()} onClick={() => k.forget(saved.id)}>忘记</Button></div>
        </div>}</For></div>
      </Show>
      <Show when={detectedKind() === "kindle"} fallback={<p class="kindle-small">已记住的设备只保存在此浏览器中；Kobo 的书目与字体直接读取设备上的文件。忘记设备不会删除设备上的书籍或身份。</p>}>
        <p class="kindle-small">每台 Kindle 分别记住排版方案。忘记设备仅删除此浏览器中的记录，不删除设备上的书籍或身份。</p>
      </Show>
      <p class="kindle-small">网页收不到插拔通知；页面可见时每 1.5 秒、重新获得焦点时自动检测。</p>
    </aside>
  </div>;
}
export const KindleConnectPage = DeviceConnectPage;
