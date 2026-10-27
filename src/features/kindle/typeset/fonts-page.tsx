import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { deleteFontFamily, installFonts, type FontFamily, type FontInstallProgress } from "../../../client/kindle/fonts";
import { deviceInventory } from "../../../client/kindle/inventory";
import { errorMessage } from "../../../client/kindle/fs";
import type { KindleDeviceManager } from "../../../client/kindle/device";
import { Button, ConfirmDialog, Menu } from "../../../ui";
import { useDeviceNavigation } from "../../devices/navigation";
import { useOptionalKindle } from "../context";
import { usePageDevice } from "./device";
import { FontSample } from "../../devices/preview/frames";
import { Link } from "../../../shared/spa-link";
import { fileSize, inspectFontBatch } from "./model";
import { KindleIcon } from "../icons";
import { FontLanguageFilter, matchesFontLanguage, type FontLanguage } from "../../devices/font-language";
import { byteProgressDetail } from "../devices/format";

function FontInstallQueueProgress(props: { progress: FontInstallProgress; active: boolean; cancelling: boolean; cancel: () => void }) {
  const indices = createMemo(() => props.progress.files.map((_, index) => index));
  const active = createMemo(() => props.active);
  let cancel!: HTMLButtonElement;
  // A stable memo prevents byte updates from repeatedly taking keyboard focus.
  createEffect(active, value => { if (value) cancel.focus(); });
  const summary = () => {
    const progress = props.progress;
    return `共 ${progress.files.length} 个文件 · 已完成 ${progress.files.filter(file => file.state === "完成").length} · ${byteProgressDetail("已写入", progress)}`;
  };
  const stage = () => props.cancelling ? "正在取消字体安装，等待回滚" : props.progress.message;
  // Retain the cancel button after completion so its focus is not lost on removal / native disabling.
  return <section class="kindle-queue" aria-label="字体安装进度">
    <div class="kindle-section-heading"><h3>安装进度</h3><Button ref={cancel} variant="quiet" size="sm" aria-label="取消字体安装" aria-disabled={!props.active || props.cancelling ? "true" : "false"} onClick={() => { if (props.active && !props.cancelling) props.cancel(); }}>取消</Button></div>
    <p class="kindle-small kindle-mono kindle-queue-summary" data-font-install-summary>{summary()}</p>
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{stage()}</span>
    <ol class="kindle-queue-list"><For each={indices()}>{index => {
      // Keep the same rows, progress elements and live regions for every immutable snapshot.
      const file = () => props.progress.files[index]!;
      const detail = () => `${byteProgressDetail("已写入", file())} · ${file().message}`;
      return <li class="kindle-queue-item" data-font-install-file={file().filename}>
        <div class="kindle-section-heading"><strong>{file().filename}</strong><span class={`kindle-queue-state ${file().state === "失败" ? "is-failed" : file().state === "完成" ? "is-complete" : ""}`}>{file().state}</span></div>
        <p class="kindle-small">{fileSize(file().total)}</p>
        <progress class={file().state === "完成" ? "is-complete" : ""} aria-label={`${file().filename} 安装进度`} aria-valuetext={detail()} max={file().total} value={file().loaded} />
        <p class="kindle-small kindle-progress-detail">{detail()}</p>
        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{file().filename}：{file().message}</span>
      </li>;
    }}</For></ol>
  </section>;
}

export function FontsPage(props: { manager: KindleDeviceManager | null; onPreview?: (family: string) => unknown }) {
  const manager = props.manager, context = useOptionalKindle(), navigate = useDeviceNavigation();
  const kind = () => context?.kind() ?? "kindle";
  const { state } = usePageDevice(manager);
  const shared = context?.manager === manager ? context : null;
  const [families, setFamilies] = createSignal<FontFamily[]>([]), [language, setLanguage] = createSignal<FontLanguage>("all");
  const shown = () => families().filter(family => matchesFontLanguage(family, language()));
  const [scanning, setScanning] = createSignal(false), [updating, setUpdating] = createSignal(false);
  const busy = () => scanning() || updating();
  const [error, setError] = createSignal(""), [notice, setNotice] = createSignal("");
  const [pending, setPending] = createSignal<{ files: File[]; families: FontFamily[]; deviceId: string } | null>(null);
  const [deleting, setDeleting] = createSignal<FontFamily | null>(null), [dragging, setDragging] = createSignal(false);
  const [installProgress, setInstallProgress] = createSignal<FontInstallProgress | null>(null);
  const [installing, setInstalling] = createSignal(false), [cancelling, setCancelling] = createSignal(false);
  let installation: { controller: AbortController; interruption: string } | null = null;
  let input!: HTMLInputElement, generation = 0, selection = 0, disposed = false;
  const device = () => state()?.status === "granted" ? state()!.device : null;
  // Effect compute callbacks rerun on every probe, even for an unchanged key.
  // Only an actual connection change may cancel a selection or restart a scan.
  const connectionKey = createMemo(() => `${state()?.status}:${state()?.device?.identity.id ?? ""}`);
  const totalSize = () => families().reduce((sum, family) => sum + family.size, 0);
  async function scan() {
    const current = device(), request = ++generation;
    setFamilies([]); setError("");
    setScanning(Boolean(current));
    if (!current) return;
    try { const inventory = await deviceInventory(current); if (!disposed && request === generation) setFamilies(inventory.fonts); }
    catch (error) { if (!disposed && request === generation) setError(errorMessage(error)); }
    finally { if (!disposed && request === generation) setScanning(false); }
  }
  createEffect(connectionKey, () => {
    selection++; setPending(null); setDeleting(null);
    if (installation) {
      installation.interruption = state()?.message || "设备已切换，字体安装已取消";
      installation.controller.abort(); setCancelling(true);
    } else setUpdating(false);
    void scan();
  });
  onCleanup(() => { disposed = true; generation++; selection++; installation?.controller.abort(); });
  async function choose(files: File[]) {
    // A picker may return while an inventory read is still running. Inspect and
    // retain that selection; confirmation stays disabled until the read settles.
    const current = device(); if (!current || updating()) return;
    const request = ++selection; setError(""); setNotice(""); setPending(null); setInstallProgress(null);
    try {
      const grouped = await inspectFontBatch(files);
      if (!disposed && request === selection && device()?.identity.id === current.identity.id) setPending({ files, families: grouped, deviceId: current.identity.id });
    } catch (error) { if (!disposed && request === selection) setError(errorMessage(error)); }
  }
  async function install() {
    const batch = pending(), current = device();
    if (!batch || !current || batch.deviceId !== current.identity.id || busy() || installation) return;
    const operation = { controller: new AbortController(), interruption: "" };
    installation = operation;
    setUpdating(true); setInstalling(true); setCancelling(false); setError(""); setNotice("");
    const key = connectionKey();
    try {
      await installFonts(current, batch.files, { signal: operation.controller.signal, onProgress: progress => {
        if (!disposed && installation === operation) setInstallProgress(progress);
      } });
      if (disposed || key !== connectionKey()) return;
      setPending(null); setNotice(`已安装 ${batch.files.length} 个字体文件。请重启设备或重新插拔后查看。`);
      await scan();
      if (!disposed && key === connectionKey()) await shared?.refreshInventory();
    } catch (error) { if (!disposed) setError(operation.interruption || errorMessage(error)); }
    finally {
      if (installation === operation) installation = null;
      if (!disposed) { setUpdating(false); setInstalling(false); setCancelling(false); }
    }
  }
  async function remove() {
    const family = deleting(), current = device(); if (!family || !current) throw new Error("请先连接并授权设备");
    const key = connectionKey(); setUpdating(true);
    try {
      await deleteFontFamily(current, family.name);
      if (!disposed && key === connectionKey()) {
        setNotice(`已删除 ${family.name}。使用它的排版方案需要重新选择字体。`); await scan();
        if (!disposed && key === connectionKey()) await shared?.refreshInventory();
      }
    } finally { if (!disposed && key === connectionKey()) setUpdating(false); }
  }
  return <section class={`kt-page ${dragging() ? "kt-dragging" : ""}`} aria-label="字体管理"
    onDragOver={event => { event.preventDefault(); if (device() && !busy()) setDragging(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer) void choose(Array.from(event.dataTransfer.files)); }}>
    <div class="kindle-toolbar kindle-books-toolbar kt-font-toolbar">
      <div class="kindle-section-heading"><span class="kindle-count kindle-mono">{families().length} 个家族 · {families().reduce((sum, family) => sum + family.fonts.length, 0)} 个字体文件 · {fileSize(totalSize())}</span></div>
      <FontLanguageFilter value={language()} onChange={setLanguage} />
      <div class="kindle-toolbar-actions kt-actions"><Button variant="secondary" disabled={!device() || busy()} onClick={scan}>重新扫描</Button><Button disabled={!device() || busy()} onClick={() => input.click()}>添加字体</Button></div>
    </div>
    <input ref={input} type="file" multiple accept=".ttf,.otf" hidden aria-label="选择 TTF 或 OTF 字体文件" onChange={event => { void choose(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
    <Show when={!state()}><p role="status">检测中…</p></Show>
    <Show when={state() && !device()}><p class="notice">请连接并授权设备后查看或管理字体。<Link href="/devices/connect">连接设备</Link></p></Show>
    <Show when={busy()}><p role="status">正在读取或更新设备字体…</p></Show>
    <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show>
    <Show when={notice()}><p role="status" class="notice">{notice()}</p></Show>
    <Show when={pending()}>{batch => <section class="kt-install" aria-label="待安装字体"><h3>将安装到 {device()?.identity.name}</h3>
      <For each={batch().families}>{family => <p><strong>{family.name}</strong> · {family.fonts.map(font => font.filename).join("、")} · {fileSize(family.size)}</p>}</For>
      <p class="muted">同名文件不会被覆盖；确认后写入设备。</p><div class="kt-actions"><Button disabled={busy() || !device()} onClick={install}>确认安装</Button><Button variant="quiet" disabled={busy()} onClick={() => setPending(null)}>取消选择</Button></div>
    </section>}</Show>
    <Show when={installProgress()}>{progress => <FontInstallQueueProgress progress={progress()} active={installing() && progress().state !== "完成" && progress().state !== "失败"} cancelling={cancelling()} cancel={() => { setCancelling(true); installation?.controller.abort(); }} />}</Show>
    <section class="device-font-grid" aria-label="字体列表"><For each={shown()}>{family => <article data-font-family={family.name}>
      <Link class="device-font-preview" href={`/devices/preview?font=${encodeURIComponent(family.name)}`} aria-label={`用 ${family.name} 预览`} onClick={event => {
        if (props.onPreview && !event.defaultPrevented && !event.button && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); props.onPreview(family.name); }
      }}><Show when={device()}>{current => <FontSample device={current()} family={family} />}</Show></Link>
      <Menu title={family.name} trigger={<strong>{family.name}</strong>} subtitle={`${family.fonts.length} 个文件 · ${fileSize(family.size)}`} items={[
        { label: `用 ${family.name} 预览`, onSelect: () => props.onPreview ? props.onPreview(family.name) : navigate(`/devices/preview?font=${encodeURIComponent(family.name)}`) },
        { label: `从设备删除 ${family.name}`, destructive: true, disabled: busy() || !device(), onSelect: () => setDeleting(family) },
      ]} />
      <div class="kt-coverage"><For each={["R", "B", "I", "BI"]}>{code => <span class={family.coverage.includes(code) ? "" : "is-missing"} title={`${({ R: "常规", B: "粗体", I: "斜体", BI: "粗斜体" } as Record<string, string>)[code]}${family.coverage.includes(code) ? "" : "（缺失）"}`}>{code}</span>}</For></div>
      <details class="kindle-small"><summary>字体文件与样式</summary><p>手动安装</p><p>{family.fonts.map(font => font.filename).join(" · ")}</p><p>{family.coverage.filter(code => !["R", "B", "I", "BI"].includes(code)).join("、")}</p><p>{["R", "B", "I", "BI"].every(code => family.coverage.includes(code)) ? "四种样式齐全" : "缺少的粗体 / 斜体可能由设备模拟"}</p></details>
    </article>}</For></section>
    <Show when={device() && !busy() && families().length === 0 && !error()}><p class="muted">设备 fonts/ 目录中还没有可用字体。</p></Show>
    <Show when={families().length > 0 && shown().length === 0}><p class="muted">没有{language() === "cjk" ? "中文" : "西文"}字体。</p></Show>
    <section class="kt-font-help" aria-label="添加字体"><div><h2>添加字体</h2><p>把 TTF / OTF 文件拖到这个页面上，或点击「添加字体」。请一起添加同一家族的常规、粗体、斜体与粗斜体文件。</p><p>R 常规 · B 粗体 · I 斜体 · BI 粗斜体。缺少的粗体和斜体可能由设备模拟，效果会与真实字形不同。</p></div><p><KindleIcon name="warning" />增删字体后，需要重启设备或重新插拔，字体列表才会更新。</p></section>
    <ConfirmDialog open={Boolean(deleting())} title="从设备删除字体？" danger confirmLabel="删除整个家族" onClose={() => { if (!busy()) setDeleting(null); }} onConfirm={remove}>
      <p>将删除 {deleting()?.name} 的全部 {deleting()?.fonts.length} 个文件。使用此字体的排版方案不会自动改写。</p>
    </ConfirmDialog>
  </section>;
}
