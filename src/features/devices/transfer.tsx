import TablerCheck from "~icons/tabler/check";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { defaultProfile, DEFAULT_PROFILE_ID, type TypesettingProfile } from "../../client/devices/profiles";
import { defaultReadingSettings, readingSettings, type DeviceReadingSettings } from "../../client/devices/typeset";
import type { DeviceKind } from "../../client/devices/models";
import type { DeviceBook } from "../../client/devices/inventory";
import { BookCover, Button, EmptyState, Icon, Pagination, SearchPill, SectionTitle, SegmentedControl, SelectPill, SideSheet, ToggleChip } from "../../ui";
import { useDeviceNavigation } from "./navigation";
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
function TransferQueueRow(props: { item: () => TransferItem; title: string; deviceName?: string; cancel: () => void; retry?: () => void; cover?: JSX.Element }) {
  const item = props.item;
  const running = () => item().state !== "完成" && item().state !== "失败" && item().state !== "等待";
  const determinate = () => (item().phase === "download" || item().phase === "write") && item().total !== undefined && item().total! > 0;
  return <li class="kindle-queue-item" data-queue-item={item().id}>
    <Show when={props.cover}><span class="device-send-queue-cover" aria-hidden="true">{props.cover}</span></Show>
    <div class="device-send-queue-main">
      <div class="kindle-section-heading"><strong>{props.title}</strong><span class={`kindle-queue-state ${item().state === "失败" ? "is-failed" : item().state === "完成" ? "is-complete" : ""}`}>{item().state}</span></div>
      <Show when={running()}><progress aria-label={`${props.title} 传输进度`} aria-valuetext={progressDetail(item())} max={determinate() ? item().total : 1} value={determinate() ? item().loaded ?? 0 : undefined} /></Show>
      <div class="kindle-queue-meta">
        <p class={`kindle-small kindle-progress-detail ${item().state === "失败" ? "is-failed" : ""}`}>{props.deviceName ? `${props.deviceName} · ` : ""}{progressDetail(item())}</p>
        <Show when={item().state !== "完成" && item().state !== "失败"}><Button class="kindle-text-button" variant="quiet" aria-label={`取消 ${props.title}`} onClick={props.cancel}>取消</Button></Show>
        <Show when={item().state === "失败" && props.retry}><Button class="kindle-text-button kindle-retry" variant="quiet" aria-label={`重试 ${props.title}`} onClick={() => props.retry!()}>重试</Button></Show>
      </div>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{props.title}：{stageAnnouncement(item())}</span>
    </div>
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
export function DeviceTransferQueueProgress(props: { items: readonly TransferItem[]; title: (id: string) => string; deviceName: (id: string) => string; currentDeviceId?: string; cancel: (id: string) => void; retry?: (id: string) => void; cover?: (id: string) => JSX.Element }) {
  const byId = createMemo(() => new Map(props.items.map(item => [item.id, item])));
  const ids = createMemo(() => props.items.map(item => item.id));
  return <ol class="kindle-queue-list"><For each={ids()} fallback={<li class="kindle-small kindle-queue-empty">选择书籍后开始传输。</li>}>{id => {
    // Stable IDs preserve rows and live regions when immutable progress snapshots arrive.
    const initial = byId().get(id)!;
    const item = createMemo(() => byId().get(id) ?? initial);
    // The target is only worth naming when it is not the device this page shows.
    const deviceName = () => initial.deviceId === props.currentDeviceId ? undefined : props.deviceName(initial.deviceId);
    return <TransferQueueRow item={item} title={props.title(initial.bookId)} deviceName={deviceName()} cover={props.cover?.(initial.bookId)} cancel={() => props.cancel(id)} retry={props.retry && (() => props.retry!(id))} />;
  }}</For></ol>;
}

export interface TransferReadingApi {
  get(deviceId: string, kind: DeviceKind): Promise<DeviceReadingSettings>;
  save(deviceId: string, kind: DeviceKind, settings: DeviceReadingSettings): Promise<unknown>;
}
export function DeviceTransferPage(props: { books: DeviceLibraryBook[]; preselected?: string[]; loadProfiles: () => Promise<TypesettingProfile[]>; reading?: TransferReadingApi }) {
  // Books sent from the library start selected, under "全部" so copies already on the device stay visible.
  const handed = untrack(() => (props.preselected ?? []).filter(id => props.books.some(book => book.book_id === id)));
  const navigate = useDeviceNavigation();
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
  return <SideSheet open title={target() ? `发送到${target()}` : "发送到设备"} onClose={() => navigate("/devices")} class="device-send-sheet" actions={<TransferFooter />}>
    <aside aria-label="传输" class="device-send-body">
        <section class="device-send-queue" aria-label="传输队列">
          <div class="device-send-queue-head">
            <h2>{active().length ? `正在传输 · ${active().length}` : "队列"}</h2>
            <div class="kindle-queue-actions">
              <Show when={active().length}><Button class="kindle-text-button" variant="quiet" onClick={() => active().forEach(i => k.cancel(i.id))}>全部取消</Button></Show>
              <Show when={finished()}><Button class="kindle-text-button" variant="quiet" onClick={k.clearFinished}>清除已结束</Button></Show>
            </div>
          </div>
          <Show when={k.items().length}><p class="kindle-small kindle-queue-summary" data-queue-summary>{queueSummary(k.items())}</p></Show>
          <DeviceTransferQueueProgress items={k.items()} title={title} deviceName={id => k.remembered().find(d => d.id === id)?.identity.name || id} currentDeviceId={k.state().device?.identity.id} cancel={k.cancel} retry={k.retry} cover={id => { const book = props.books.find(item => item.book_id === id); return book ? <BookCover compact book_id={book.book_id} title={book.title} author={book.author} cover_url={book.cover_url} /> : undefined; }} />
        </section>
      <section class="device-send-picker" aria-label="从书库选择">
        <div class="device-send-picker-head"><h2>从书库选择</h2><Show when={chosen().length}><span class="kindle-selection" data-transfer-selection>估计大小：<span class="kindle-mono">{knownSize() ? `约 ${bytes(knownSize())}（按设备已有副本）` : "待转换后确定"}</span>{unknown() && knownSize() ? `，另 ${unknown()} 本待确定` : ""}</span></Show></div>
        <div class="kindle-toolbar device-send-filters"><SearchPill label="搜索书库" placeholder="搜索书库" value={query()} onInput={e => { setQuery(e.currentTarget.value); setPage(1); }} /><SegmentedControl label="筛选" value={filter()} options={["不在设备", "未读", "全部"].map(value => ({ value, label: value }))} onChange={value => { setFilter(value); setPage(1); }} /></div>
        <Show when={shown().length} fallback={<EmptyState title={props.books.length ? "没有符合条件的书籍" : "书库还是空的"}>可调整筛选，或先向书库添加书籍。</EmptyState>}>
          <ul class="device-send-grid"><For each={shown()}>{book => <li data-transfer-book={book.book_id}><button type="button" class="device-send-book" aria-label={`选择 ${book.title}`} aria-pressed={selected().includes(book.book_id) ? "true" : "false"} onClick={() => toggleBook(book.book_id)}>
            <span class="device-send-cover"><BookCover book_id={book.book_id} title={book.title} author={book.author} cover_url={book.cover_url} /><Show when={selected().includes(book.book_id)}><span class="device-send-check" aria-hidden="true"><Icon icon={TablerCheck} size={14} /></span></Show></span>
            <strong>{book.title}</strong><span class="sr-only">{book.author}{book.read ? " · 已读" : ""}{onDevice().has(book.book_id) ? " · 已在设备" : ""}</span>
          </button></li>}</For></ul>
        </Show>
        <Show when={totalPages() > 1}><Pagination page={currentPage()} perPage={24} total={visible().length} unit="本" label="书库分页" onPage={setPage} /></Show>
        <Show when={!deviceId() || !k.inventory()}><p class="notice">{!k.ready() ? "检测中…" : !deviceId() ? "请先连接并授权设备。" : "正在读取设备清单，完成后显示设备已有书籍。"} <Link href="/devices/connect">连接与切换设备</Link></p></Show>
        <p class="sr-only" role="status">已选 {chosen().length} 本</p>
      </section>
    </aside>
    <Show when={kindle()}><BokoLicense /></Show>
  </SideSheet>;

  // Outside the scrolling queue/picker: actions stay at the bottom for short and long lists.
  function TransferFooter() {
    return <div class="device-send-footer">
        <h2 class="sr-only">设置</h2>
        <div class="kindle-target" data-transfer-target>
          <div><span class="kindle-small">目标设备</span><span class="kindle-target-name"><strong>{target() || "尚未连接设备"}</strong><Show when={target()}><span aria-hidden="true" class={`kindle-dot ${deviceId() ? "connected" : ""}`} /><span class={`kindle-small ${deviceId() ? "is-connected" : "is-offline"}`}>{targetStatus()}</span></Show></span></div>
          <Link class="kindle-target-link" href="/devices/connect">{deviceId() ? "切换设备" : target() ? "重新连接" : "连接设备"}</Link>
        </div>
        <div class="device-send-actions">
          <SelectPill label="排版方案" value={profile()} disabled={!deviceId() || profilesBusy()} options={[...profiles().map(p => ({ value: p.id, label: p.name })), { value: "edit", label: "编辑排版方案…" }]} onChange={id => {
            if (id === "edit") { navigate(`/devices/preview${chosen()[0] ? `?book=${encodeURIComponent(chosen()[0]!.book_id)}` : ""}`); return; }
            setProfile(id);
            const device = deviceId(), api = props.reading;
            if (!device || !api) return;
            const value = readingSettings(kind(), { ...deviceReading(), profileId: id });
            setDeviceReading(value);
            void api.save(device, kind(), value).catch(error => { if (device === deviceId()) setProfileError(error instanceof Error ? error.message : "排版方案保存失败"); });
          }} />
          <ToggleChip aria-label="覆盖设备上的同名书" selected={overwrite()} onClick={() => setOverwrite(!overwrite())}>覆盖同名</ToggleChip>
          <div class="kindle-start">
            <Button class="kindle-start-transfer" variant={canStart() ? "primary" : "secondary"} disabled={!canStart()} onClick={start}>{chosen().length ? `发送 ${chosen().length} 本` : "发送"}</Button>
          </div>
        </div>
        <Show when={profileSummary()}><p class="kindle-small" data-profile-summary>{profileSummary()}</p></Show>
        <Show when={profileError()}><p class="field-error" role="alert">{profileError()} <Button variant="quiet" size="sm" onClick={() => reloadProfiles(deviceId())}>重试</Button></p></Show>
        <Show when={startHint()}><p class="kindle-small" data-start-hint>{startHint()}</p></Show>
      </div>;
  }
}
export const KindleTransferPage = DeviceTransferPage;
export const KindleTransferQueueProgress = DeviceTransferQueueProgress;
