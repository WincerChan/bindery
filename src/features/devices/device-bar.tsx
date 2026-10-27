import { For, Show } from "solid-js";
import { useDevice } from "./context";
import { bytes } from "./format";
import { kindleModelInfo, koboModelInfo, modelShortName } from "../../client/devices/models";
import { BackgroundActivityPill, Button, Icon, IconButton, PageIntro, SelectPill, StatusDot } from "../../ui";
import { Link } from "../../shared/spa-link";
import { useDeviceNavigation } from "./navigation";
import { DeviceShell } from "./device-shell";
import { ReadingPage, type LoadDevicePageSample } from "./reading-page";

export function DeviceBar(props: { compact?: boolean; loadPage?: LoadDevicePageSample }) {
  const k = useDevice(), navigateSpa = useDeviceNavigation();
  const device = () => k.ready() ? k.state().device : null;
  const status = () => !k.ready() ? "检测中…" : !k.supported() ? "此浏览器不支持设备磁盘访问" : ({ granted: "已连接", prompt: "已插入 · 需要授权", denied: "已拒绝", disconnected: "已断开", unpaired: "未配对或未选择设备" })[k.state().status];
  const usage = () => k.inventory()?.usage;
  const model = () => device() ? (device()!.identity.kind === "kindle" ? kindleModelInfo : koboModelInfo)(device()!.identity.model).name : "";
  const firmware = () => device()?.firmware ? /\d+(?:\.\d+)+/.exec(device()!.firmware!)?.[0] ?? device()!.firmware : "";
  const active = () => k.items().filter(item => item.state !== "完成" && item.state !== "失败").length;
  const current = () => [...k.inventory()?.books ?? []].filter(book => book.progress?.last_read_at || book.progress?.percent).sort((a, b) => String(b.progress?.last_read_at ?? "").localeCompare(String(a.progress?.last_read_at ?? "")))[0];
  const currentId = () => current()?.book_id ?? current()?.record?.book_id;
  const preview = () => `/devices/preview${currentId() ? `?book=${encodeURIComponent(currentId()!)}` : ""}`;
  const specifications = () => device() ? (device()!.identity.kind === "kindle" ? kindleModelInfo : koboModelInfo)(device()!.identity.model) : null;
  const width = (n: number) => `${usage()?.total ? n / usage()!.total * 100 : 0}%`;
  return <section aria-label="当前设备" class={`device-intro ${props.compact ? "device-intro-compact" : ""}`} data-kindle-device-bar>
    <PageIntro eyebrow={<><StatusDot label={status()} tone={k.state().status === "granted" ? "ok" : "empty"} /><span role="status">{[status(), model(), firmware() ? `固件 ${firmware()}` : ""].filter(Boolean).join(" · ")}</span></>}
      title={device() ? props.compact ? device()!.identity.name : `${device()!.identity.name}，上面有 ${k.inventory()?.books.length ?? 0} 本书。` : "设备"}
      actions={<>
        <Button size="lg" onClick={() => navigateSpa("/devices/transfer")}>从书库发送</Button>
        <Show when={active()}><BackgroundActivityPill count={`${active()} 本`} onClick={() => navigateSpa("/devices/transfer")}>传输中 {active()} 本</BackgroundActivityPill></Show>
        <SelectPill label="切换设备" value={device()?.identity.id ?? ""} disabled={!k.ready() || !k.supported() || k.busy()} options={[
          ...(!device() ? [{ value: "", label: "选择设备" }] : []),
          ...k.remembered().map(saved => ({ value: saved.id, label: `${saved.identity.name.trim() || modelShortName(saved.identity.kind, saved.identity.model)} · ${k.connections()[saved.id] ? "已连接" : "未连接"}` })),
          { value: "new", label: "连接新设备…" },
        ]} onChange={id => { if (id === "new") navigateSpa("/devices/connect"); else if (id) void k.switchDevice(id); }} />
        <IconButton aria-label="重新检测" title="重新检测" size="lg" disabled={k.busy() || !k.supported()} onClick={k.refresh}><Icon name="refresh" size={22} /></IconButton>
        <Show when={k.state().status === "prompt" || k.state().status === "denied"}><Button onClick={() => k.authorize()}>授权</Button></Show>
      </>}
      visual={!props.compact && <figure class="device-intro-visual"><Link href={preview()} aria-label="打开设备排版预览"><DeviceShell kind={k.kind()} model={device()?.identity.model ?? "KPW3"} idle={!device()}>
        <Show when={current() && device()} fallback={<p>还没有可用的阅读位置。<br />点开预览，选一本书。</p>}><ReadingPage deviceId={device()!.identity.id} book={current()!} kind={k.kind()} model={device()!.identity.model} revision={k.syncSummary()} load={props.loadPage} /></Show>
      </DeviceShell></Link><figcaption><Link href={preview()}>章节样张 · 点开看排版<Icon name="arrow-right" size={15} class="ui-icon-inline" /></Link></figcaption></figure>} />
    <Show when={!props.compact && usage()}><div class="kindle-usage" aria-busy={k.inventoryBusy() ? "true" : "false"}><div class="kindle-usage-bar" role="img" aria-label={`书籍 ${bytes(usage()!.books)}，字体 ${bytes(usage()!.fonts)}，其他 ${bytes(usage()!.other)}`}>
      <span class="books" style={{ width: width(usage()!.books) }} /><span class="fonts" style={{ width: width(usage()!.fonts) }} /><span class="other" style={{ width: width(usage()!.other) }} />
    </div><p class="kindle-small">书籍 {bytes(usage()!.books)} · 字体 {bytes(usage()!.fonts)} · 其他 {bytes(usage()!.other)} · 已枚举文件 {bytes(usage()!.total)}</p></div></Show>
    <Show when={device()}><details class="kindle-small"><summary>设备信息</summary><p>{model()}{specifications()?.width ? ` · ${specifications()!.width}×${specifications()!.height} · ${specifications()!.ppi} ppi` : ""}{firmware() ? ` · 固件 ${firmware()}` : ""}</p><p>文件统计不代表设备总容量或剩余空间。</p><Link href="/devices/connect">连接与管理记住的设备</Link></details></Show>
    <Show when={k.ready() && !k.supported()}><p class="kindle-small">请在 Windows 的 Edge 或 Chrome 桌面版中通过 HTTPS 或 localhost 打开。</p></Show>
    <Show when={k.syncSummary()}><p class="kindle-small" role="status" data-reading-sync>{k.syncSummary()}</p></Show>
    <Show when={k.syncError()}><p class="field-error" role="alert" data-reading-sync>{k.syncError()}</p></Show>
    <Show when={k.inventory()?.unreadableCount}><details class="kindle-entry-notice" data-unreadable-notice><summary>有 {k.inventory()!.unreadableCount} 个条目无法读取（路径超过 Windows 260 字符限制等），已跳过统计</summary><ul><For each={k.inventory()!.unreadable}>{entry => <li>{entry.path}（{entry.reason}；{entry.likelyCause}；Windows 路径 {entry.windowsPathLength} 字符）</li>}</For></ul></details></Show>
    <Show when={k.error() || k.inventoryError()}><p class="field-error" role="alert">{k.error() || k.inventoryError()}</p></Show>
  </section>;
}
export const KindleDeviceBar = DeviceBar;
