import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { defaultProfile, DEFAULT_PROFILE_ID, type TypesettingProfile } from "../../client/devices/profiles";
import { defaultReadingSettings, readingSettings, type DeviceReadingSettings } from "../../client/devices/typeset";
import type { DeviceKind } from "../../client/devices/models";
import type { DeviceBook } from "../../client/devices/inventory";
import { BookCover, Button, Checkbox, Chip, EmptyState, Select, TextField } from "../../ui";
import { useDevice } from "./context";
import { byteProgressDetail, bytes, megabytes } from "./format";
import { createDeviceLibraryResolver, type DeviceLibraryBook, type DeviceLibraryResolver } from "./library";
import { BokoLicense } from "../kindle/devices/boko-license";
import { Link } from "../../shared/spa-link";
import type { TransferItem } from "../../client/devices/queue";

function progressDetail(item: TransferItem) {
  if ((item.phase !== "download" && item.phase !== "write") || item.loaded === undefined || item.state === "失败" || item.state === "等待" || item.state === "完成") return item.message;
  const label = item.phase === "write" ? "已写入" : "已下载";
  return byteProgressDetail(label, item);
}
function stageAnnouncement(item: TransferItem) {
  if (item.state === "等待" || item.state === "完成" || item.state === "失败") return `${item.state}：${item.message}`;
  return ({ download: "正在下载 EPUB", convert: item.kind === "kobo" ? "正在转换 KEPUB，耗时为估计" : "正在转换 KFX，耗时为估计", write: "正在写入设备", thumbnail: "正在生成封面缩略图", finalize: "正在完成写入" })[item.phase];
}
function TransferQueueRow(props: { item: () => TransferItem; title: string; deviceName?: string; cancel: () => void; retry?: () => void }) {
  const item = props.item;
  const running = () => item().state !== "完成" && item().state !== "失败" && item().state !== "等待";
  const determinate = () => (item().phase === "download" || item().phase === "write") && item().total !== undefined && item().total! > 0;
  return <li class="kindle-queue-item" data-queue-item={item().id}>
    <div class="kindle-section-heading"><strong>{props.title}</strong><span class={`kindle-queue-state ${item().state === "失败" ? "is-failed" : item().state === "完成" ? "is-complete" : ""}`}>{item().state}</span></div>
    <Show when={running()}><progress aria-label={`${props.title} 传输进度`} aria-valuetext={progressDetail(item())} max={determinate() ? item().total : 1} value={determinate() ? item().loaded ?? 0 : undefined} /></Show>
    <div class="kindle-queue-meta">
      <p class={`kindle-small kindle-progress-detail ${item().state === "失败" ? "is-failed" : ""}`}>{props.deviceName ? `${props.deviceName} · ` : ""}{progressDetail(item())}</p>
      <Show when={item().state !== "完成" && item().state !== "失败"}><Button class="kindle-text-button" variant="quiet" aria-label={`取消 ${props.title}`} onClick={props.cancel}>取消</Button></Show>
      <Show when={item().state === "失败" && props.retry}><Button class="kindle-text-button kindle-retry" variant="quiet" aria-label={`重试 ${props.title}`} onClick={() => props.retry!()}>重试</Button></Show>
    </div>
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{props.title}：{stageAnnouncement(item())}</span>
  </li>;
}
export function queueSummary(items: readonly TransferItem[]) {
  const failed = items.filter(item => item.state === "失败").length;
  const prefix = `共 ${items.length} 本 · 已完成 ${items.filter(item => item.state === "完成").length}${failed ? ` · 失败 ${failed}` : ""}`;
  // A single book shows its own bytes in its row, and finished batches have nothing left to measure.
  if (items.length < 2 || items.every(item => item.state === "完成" || item.state === "失败")) return prefix;
  const downloads = items.filter(item => item.downloadTotal !== undefined), known = items.filter(item => item.writeTotal !== undefined);
  const downloaded = downloads.reduce((sum, item) => sum + item.downloadedBytes, 0), downloadTotal = downloads.reduce((sum, item) => sum + item.downloadTotal!, 0);
  const downloadUnknown = items.length - downloads.length;
  const download = downloads.length ? ` · 已下载 ${megabytes(downloaded)} / ${megabytes(downloadTotal)} MB${downloadUnknown ? `（另 ${downloadUnknown} 本下载大小未知）` : ""}` : "";
  if (!known.length) return prefix + download;
  const written = known.reduce((sum, item) => sum + item.writtenBytes, 0), total = known.reduce((sum, item) => sum + item.writeTotal!, 0);
  const unknown = items.length - known.length;
  return `${prefix}${download} · 已写入 ${megabytes(written)} / ${megabytes(total)} MB${unknown ? `（另 ${unknown} 本待转换）` : ""}`;
}
export function DeviceTransferQueueProgress(props: { items: readonly TransferItem[]; title: (id: string) => string; deviceName: (id: string) => string; currentDeviceId?: string; cancel: (id: string) => void; retry?: (id: string) => void }) {
  const byId = createMemo(() => new Map(props.items.map(item => [item.id, item])));
  const ids = createMemo(() => props.items.map(item => item.id));
  return <ol class="kindle-queue-list"><For each={ids()} fallback={<li class="kindle-small kindle-queue-empty">选择书籍后开始传输。</li>}>{id => {
    // Stable IDs preserve rows and live regions when immutable progress snapshots arrive.
    const initial = byId().get(id)!;
    const item = createMemo(() => byId().get(id) ?? initial);
    // The target is only worth naming when it is not the device this page shows.
    const deviceName = () => initial.deviceId === props.currentDeviceId ? undefined : props.deviceName(initial.deviceId);
    return <TransferQueueRow item={item} title={props.title(initial.bookId)} deviceName={deviceName()} cancel={() => props.cancel(id)} retry={props.retry && (() => props.retry!(id))} />;
  }}</For></ol>;
}

export interface TransferReadingApi {
  get(deviceId: string, kind: DeviceKind): Promise<DeviceReadingSettings>;
  save(deviceId: string, kind: DeviceKind, settings: DeviceReadingSettings): Promise<unknown>;
}
export function DeviceTransferPage(props: { books: DeviceLibraryBook[]; preselected?: string[]; loadProfiles: () => Promise<TypesettingProfile[]>; reading?: TransferReadingApi }) {
  // Books sent from the library start selected, under "全部" so copies already on the device stay visible.
  const handed = untrack(() => (props.preselected ?? []).filter(id => props.books.some(book => book.book_id === id)));
  const k = useDevice(), [filter, setFilter] = createSignal(handed.length ? "全部" : "不在设备"), [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string[]>(handed), [page, setPage] = createSignal(1);
  const [profiles, setProfiles] = createSignal<TypesettingProfile[]>([]), [profile, setProfile] = createSignal(DEFAULT_PROFILE_ID), [profileError, setProfileError] = createSignal("");
  const [deviceReading, setDeviceReading] = createSignal<DeviceReadingSettings>(defaultReadingSettings("kindle"));
  const [profilesBusy, setProfilesBusy] = createSignal(false), [overwrite, setOverwrite] = createSignal(false);
  const kind = () => k.kind(), kindle = () => kind() === "kindle";
  const profileSummary = () => {
    const selected = profiles().find(item => item.id === profile()), settings = selected?.settings;
    if (selected?.builtIn) return "只用书籍自带样式";
    return [settings?.stripFonts ? "去掉书籍自带字体" : "", settings?.stripImages ? "去掉所有图片（保留封面）" : "", settings?.stripPageMargins ? "去掉书籍自带页边距" : "", settings?.stripLineHeight ? "去掉书籍自带行高" : "", settings?.stripParagraphSpacing ? "去掉书籍自带段间距" : ""].filter(Boolean).join(" · ");
  };
  const deviceId = createMemo(() => k.ready() && k.state().status === "granted" ? k.state().device?.identity.id || "" : "");
  const [resolver, setResolver] = createSignal<DeviceLibraryResolver | null>(null);
  createEffect(() => [props.books, kind()] as const, ([books, deviceKind]) => {
    let alive = true; setResolver(null);
    createDeviceLibraryResolver(books, deviceKind).then(value => { if (alive) setResolver(() => value); }, () => { if (alive) setResolver(null); });
    return () => { alive = false; };
  });
  let profileRevision = 0;
  async function reloadProfiles(id: string) {
    const token = ++profileRevision; setProfileError(""); setProfiles([]); setProfile(DEFAULT_PROFILE_ID); setDeviceReading(defaultReadingSettings(kind()));
    if (!id) { setProfilesBusy(false); return; }
    setProfilesBusy(true); setProfiles([defaultProfile()]);
    try {
      const [result, saved] = await Promise.all([
        props.loadProfiles(),
        props.reading ? props.reading.get(id, kind()).catch(() => null) : Promise.resolve(null),
      ]);
      if (token !== profileRevision) return;
      const items = [defaultProfile(), ...result.filter(p => p.id !== DEFAULT_PROFILE_ID)];
      const remembered = readingSettings(kind(), saved ?? defaultReadingSettings(kind()));
      setProfiles(items); setDeviceReading(remembered);
      setProfile(items.some(item => item.id === remembered.profileId) ? remembered.profileId : DEFAULT_PROFILE_ID);
    }
    catch (e) { if (token === profileRevision) setProfileError(e instanceof Error ? e.message : "排版方案读取失败"); }
    finally { if (token === profileRevision) setProfilesBusy(false); }
  }
  // A device switch clears the selection; the hand-over from the library survives until a device is ready.
  let pending = handed;
  createEffect(deviceId, id => { setSelected(pending); if (id) pending = []; void reloadProfiles(id); return () => { profileRevision++; }; });
  const onDevice = createMemo(() => {
    const found = new Map<string, DeviceBook>(), match = resolver();
    if (!match) return found;
    for (const book of k.inventory()?.books || []) {
      const book_id = match.match(book);
      if (book_id && !found.has(book_id)) found.set(book_id, book);
    }
    return found;
  });
  const visible = () => props.books.filter(b => (filter() !== "不在设备" || !onDevice().has(b.book_id)) && (filter() !== "未读" || !b.read) && `${b.title} ${b.author || ""}`.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()));
  const totalPages = () => Math.max(1, Math.ceil(visible().length / 24));
  const currentPage = () => Math.min(page(), totalPages());
  const shown = () => visible().slice((currentPage() - 1) * 24, currentPage() * 24);
  const chosen = () => props.books.filter(b => selected().includes(b.book_id));
  const knownSize = () => chosen().reduce((sum, b) => sum + (onDevice().get(b.book_id)?.size || 0), 0);
  const unknown = () => chosen().filter(b => !onDevice().has(b.book_id)).length;
  const title = (id: string) => props.books.find(b => b.book_id === id)?.title || id;
  const active = () => k.items().filter(i => i.state !== "完成" && i.state !== "失败");
  const finished = () => k.items().some(i => i.state === "完成" || i.state === "失败");
  const label = () => kindle() ? "Kindle" : "Kobo";
  const target = () => k.ready() ? k.state().device?.identity.name : undefined;
  const targetStatus = () => !k.ready() ? "检测中" : ({ granted: "已连接", prompt: "待授权", denied: "无访问权限", disconnected: "未连接", unpaired: "未配对" })[k.state().status];
  const canStart = () => !!deviceId() && !!k.inventory() && chosen().length > 0 && !profilesBusy() && !k.busy();
  const startHint = () => {
    if (!k.ready()) return "正在检测设备…";
    if (!deviceId()) return target() ? `插入 ${label()} 并重新连接后即可传输。` : "先连接设备，再选择要传输的书。";
    if (!k.inventory()) return "正在读取设备书籍清单…";
    if (profilesBusy()) return "正在读取排版方案…";
    if (!chosen().length) return "先在书库列表中选择要传输的书。";
    return "";
  };
  function start() {
    void k.run(async () => {
      if (!deviceId() || !k.inventory()) throw new Error("请先连接设备并等待书籍清单读取完成");
      for (const book of chosen()) {
        k.enqueue(book.book_id, profile(), { overwrite: overwrite() });
      }
      setSelected([]);
    });
  }
  function toggleBook(id: string, checked = !selected().includes(id)) {
    setSelected(current => checked ? [...current.filter(value => value !== id), id] : current.filter(value => value !== id));
  }
  return <>
    <div class="kindle-split kindle-transfer">
      <section aria-label="从书库选择">
        <div class="kindle-section-heading"><h2>从书库选择</h2><span class="kindle-selection" data-transfer-selection>已选 <span class="kindle-mono">{chosen().length}</span> 本<Show when={chosen().length}> · 估计大小：<span class="kindle-mono">{knownSize() ? `约 ${bytes(knownSize())}（按设备已有副本）` : "待转换后确定"}</span>{unknown() && knownSize() ? `，另 ${unknown()} 本待确定` : ""}</Show></span></div>
        <div class="kindle-toolbar"><div class="kindle-filters" role="group" aria-label="筛选"><For each={["不在设备", "未读", "全部"]}>{value => <Chip variant="filter" selected={filter() === value} onClick={() => { setFilter(value); setPage(1); }}>{value}</Chip>}</For></div><TextField class="kindle-search search-field" label="搜索书库" labelHidden type="search" placeholder="搜索书库" value={query()} onInput={e => { setQuery(e.currentTarget.value); setPage(1); }} /></div>

        <Show when={shown().length} fallback={<EmptyState title={props.books.length ? "没有符合条件的书籍" : "书库还是空的"}>可调整筛选，或先向书库添加书籍。</EmptyState>}>
          <Checkbox class="kindle-select-page" label="全选本页" checked={shown().length > 0 && shown().every(b => selected().includes(b.book_id))} indeterminate={shown().some(b => selected().includes(b.book_id)) && !shown().every(b => selected().includes(b.book_id))} onChange={e => setSelected(current => e.currentTarget.checked ? [...new Set([...current, ...shown().map(b => b.book_id)])] : current.filter(id => !shown().some(b => b.book_id === id)))} />
          <ul class="kindle-library-list"><For each={shown()}>{book => <li data-transfer-book={book.book_id} class={selected().includes(book.book_id) ? "is-selected" : ""} onClick={event => { if (!(event.target as Element).closest("input, button, a")) toggleBook(book.book_id); }}>
            <Checkbox label="" aria-label={`选择 ${book.title}`} checked={selected().includes(book.book_id)} onChange={e => toggleBook(book.book_id, e.currentTarget.checked)} />
            <BookCover book_id={book.book_id} title={book.title} author={book.author} cover_url={book.cover_url} class="kindle-book-cover" />
            <div class="kindle-library-title"><strong>{book.title}</strong><p class="kindle-small">{book.author || "作者未知"}{book.read ? " · 已读" : " · 未读"}</p></div>
            <span class="kindle-on-device">{onDevice().has(book.book_id) ? "已在设备" : ""}</span><span class="kindle-list-size kindle-mono">{onDevice().has(book.book_id) ? bytes(onDevice().get(book.book_id)!.size) : "—"}</span>
          </li>}</For></ul>
          <Show when={totalPages() > 1}><nav aria-label="书库分页" class="kindle-actions"><Button variant="secondary" disabled={currentPage() === 1} onClick={() => setPage(currentPage() - 1)}>上一页</Button><span>{currentPage()} / {totalPages()}</span><Button variant="secondary" disabled={currentPage() === totalPages()} onClick={() => setPage(currentPage() + 1)}>下一页</Button></nav></Show>
        </Show>
        <Show when={!deviceId() || !k.inventory()}><p class="notice">{!k.ready() ? "检测中…" : !deviceId() ? "请先连接并授权设备。" : "正在读取设备清单，完成后显示设备已有书籍。"} <Link href="/devices/connect">连接与切换设备</Link></p></Show>
        <Show when={chosen().length}><div class="kindle-mobile-start" data-mobile-start><span>已选 <strong>{chosen().length}</strong> 本</span><Button variant={canStart() ? "primary" : "secondary"} disabled={!canStart()} onClick={start}>传输所选</Button></div></Show>
      </section>
      <aside aria-label="传输" class="kindle-aside">
        <h2>设置</h2>
        <div class="form-stack">
          <div class="kindle-target" data-transfer-target>
            <div><span class="kindle-small">目标设备</span><span class="kindle-target-name"><strong>{target() || "尚未连接设备"}</strong><Show when={target()}><span aria-hidden="true" class={`kindle-dot ${deviceId() ? "connected" : ""}`} /><span class={`kindle-small ${deviceId() ? "is-connected" : "is-offline"}`}>{targetStatus()}</span></Show></span></div>
            <Link class="kindle-target-link" href="/devices/connect">{deviceId() ? "切换设备" : target() ? "重新连接" : "连接设备"}</Link>
          </div>
          <Select label="排版方案" value={profile()} disabled={!deviceId() || profilesBusy()} onChange={e => {
            const id = e.currentTarget.value; setProfile(id);
            const device = deviceId(), api = props.reading;
            if (!device || !api) return;
            const value = readingSettings(kind(), { ...deviceReading(), profileId: id });
            setDeviceReading(value);
            void api.save(device, kind(), value).catch(error => { if (device === deviceId()) setProfileError(error instanceof Error ? error.message : "排版方案保存失败"); });
          }}><For each={profiles()}>{p => <option value={p.id}>{p.name}</option>}</For></Select>
          <Show when={profileSummary()}><p class="kindle-small" data-profile-summary>{profileSummary()}</p></Show>
          <Show when={profileError()}><p class="field-error" role="alert">{profileError()} <Button variant="quiet" size="sm" onClick={() => reloadProfiles(deviceId())}>重试</Button></p></Show>
          <Link class="kindle-preview-link" href="/devices/preview">预览并调整排版方案</Link>
          <div class="kindle-check-group">
            <Show when={kindle()}><Checkbox label="写入封面缩略图（有封面时自动写入）" checked disabled /></Show>
            <Checkbox label="覆盖设备上的同名书" checked={overwrite()} onChange={e => setOverwrite(e.currentTarget.checked)} />
          </div>
          <p class="kindle-small">{kindle() ? "覆盖仅替换 Bindery 记录的同一本书，保留原文件名与 .sdr 阅读记录。" : "覆盖仅替换 Bindery 记录的同一本书。"}其他来源或不同书籍的同名文件会另存副本。</p>
          <div class="kindle-start">
            <Button class="kindle-start-transfer" variant={canStart() ? "primary" : "secondary"} disabled={!canStart()} onClick={start}>{chosen().length ? `开始传输 · ${chosen().length} 本` : "开始传输"}</Button>
            <Show when={startHint()}><p class="kindle-small" data-start-hint>{startHint()}</p></Show>
          </div>
        </div>
        <section class="kindle-queue" aria-label="传输队列">
          <div class="kindle-section-heading">
            <h2>队列</h2>
            <div class="kindle-queue-actions">
              <Show when={active().length}><Button class="kindle-text-button" variant="quiet" onClick={() => active().forEach(i => k.cancel(i.id))}>全部取消</Button></Show>
              <Show when={finished()}><Button class="kindle-text-button" variant="quiet" onClick={k.clearFinished}>清除已结束</Button></Show>
            </div>
          </div>
          <Show when={k.items().length}><p class="kindle-small kindle-queue-summary" data-queue-summary>{queueSummary(k.items())}</p></Show>
          <DeviceTransferQueueProgress items={k.items()} title={title} deviceName={id => k.remembered().find(d => d.id === id)?.identity.name || id} currentDeviceId={k.state().device?.identity.id} cancel={k.cancel} retry={k.retry} />
        </section>
        <p class="kindle-small">传输时请保持页面打开。切换标签页不影响，刷新或关闭网页会中断传输。</p>
        <Show when={kindle()}><p class="kindle-small">EPUB 在浏览器内由 boko 转换为 KFX。<Link href="#boko-license">boko 许可证与对应源码</Link></p></Show>
      </aside>
    </div>
    <Show when={kindle()}><BokoLicense /></Show>
  </>;
}
export const KindleTransferPage = DeviceTransferPage;
export const KindleTransferQueueProgress = DeviceTransferQueueProgress;
