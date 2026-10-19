import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { defaultProfile, type TypesettingProfile } from "../../../client/kindle";
import { BookCover, Button, Checkbox, Chip, EmptyState, Select, TextField } from "../../../ui";
import { useKindle } from "../context";
import { bytes } from "./format";
import type { KindleLibraryBook } from "./library";
import { BokoLicense } from "./boko-license";

export function KindleTransferPage(props: { books: KindleLibraryBook[]; loadProfiles: (deviceId: string) => Promise<TypesettingProfile[]> }) {
  const k = useKindle(), [filter, setFilter] = createSignal("不在设备"), [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string[]>([]), [page, setPage] = createSignal(1);
  const [profiles, setProfiles] = createSignal<TypesettingProfile[]>([]), [profile, setProfile] = createSignal("default"), [profileError, setProfileError] = createSignal("");
  const [profilesBusy, setProfilesBusy] = createSignal(false), [overwrite, setOverwrite] = createSignal(false), [notice, setNotice] = createSignal("");
  // Probe notifications replace DeviceState every 1.5 s; only an actual target change resets choices.
  const deviceId = createMemo(() => k.ready() && k.state().status === "granted" ? k.state().device?.identity.id || "" : "");
  let profileRevision = 0;
  async function reloadProfiles(id: string) {
    const token = ++profileRevision; setProfileError(""); setProfilesBusy(true); setProfiles(id ? [defaultProfile(id)] : []); setProfile("default");
    try { if (id) { const result = await props.loadProfiles(id); if (token === profileRevision) setProfiles([defaultProfile(id), ...result.filter(p => p.id !== "default")]); } }
    catch (e) { if (token === profileRevision) setProfileError(e instanceof Error ? e.message : "排版方案读取失败"); }
    finally { if (token === profileRevision) setProfilesBusy(false); }
  }
  createEffect(deviceId, id => { setSelected([]); void reloadProfiles(id); return () => { profileRevision++; }; });
  const onDevice = createMemo(() => new Map((k.inventory()?.books || []).filter(b => b.record).map(b => [b.record!.book_id, b])));
  const visible = () => props.books.filter(b => (filter() !== "不在设备" || !onDevice().has(b.book_id)) && (filter() !== "未读" || !b.read) && `${b.title} ${b.author || ""}`.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()));
  const totalPages = () => Math.max(1, Math.ceil(visible().length / 24));
  const currentPage = () => Math.min(page(), totalPages());
  const shown = () => visible().slice((currentPage() - 1) * 24, currentPage() * 24);
  const chosen = () => props.books.filter(b => selected().includes(b.book_id));
  const knownSize = () => chosen().reduce((sum, b) => sum + (onDevice().get(b.book_id)?.size || 0), 0);
  const unknown = () => chosen().filter(b => !onDevice().has(b.book_id)).length;
  const title = (id: string) => props.books.find(b => b.book_id === id)?.title || id;
  const active = () => k.items().filter(i => i.state !== "完成" && i.state !== "失败");
  function start() {
    void k.run(async () => {
      if (!deviceId() || !k.inventory()) throw new Error("请先连接设备并等待书籍清单读取完成");
      for (const book of chosen()) k.enqueue(book.book_id, profile(), overwrite());
      setNotice(`已加入 ${chosen().length} 本书，传输期间请保持页面打开和 USB 连接。`); setSelected([]);
    });
  }
  return <>
    <div class="kindle-split kindle-transfer">
      <section aria-label="从书库选择">
        <div class="kindle-section-heading"><h2>从书库选择</h2><span class="kindle-selection" data-transfer-selection>已选 <span class="kindle-mono">{chosen().length}</span> 本<Show when={chosen().length}> · 估计大小：<span class="kindle-mono">{knownSize() ? `约 ${bytes(knownSize())}（按设备已有副本）` : "待转换后确定"}</span>{unknown() && knownSize() ? `，另 ${unknown()} 本待确定` : ""}</Show></span></div>
        <div class="kindle-toolbar"><div class="kindle-filters" role="group" aria-label="筛选"><For each={["不在设备", "未读", "全部"]}>{value => <Chip variant="filter" selected={filter() === value} onClick={() => { setFilter(value); setPage(1); }}>{value}</Chip>}</For></div><TextField class="kindle-search" label="搜索书库" labelHidden type="search" placeholder="搜索书库" value={query()} onInput={e => { setQuery(e.currentTarget.value); setPage(1); }} /></div>

        <Show when={shown().length} fallback={<EmptyState title={props.books.length ? "没有符合条件的书籍" : "书库还是空的"}>可调整筛选，或先向书库添加书籍。</EmptyState>}>
          <Checkbox class="kindle-select-page" label="全选本页" checked={shown().length > 0 && shown().every(b => selected().includes(b.book_id))} indeterminate={shown().some(b => selected().includes(b.book_id)) && !shown().every(b => selected().includes(b.book_id))} onChange={e => setSelected(current => e.currentTarget.checked ? [...new Set([...current, ...shown().map(b => b.book_id)])] : current.filter(id => !shown().some(b => b.book_id === id)))} />
          <ul class="kindle-library-list"><For each={shown()}>{book => <li data-transfer-book={book.book_id} class={selected().includes(book.book_id) ? "is-selected" : ""}>
            <Checkbox label="" aria-label={`选择 ${book.title}`} checked={selected().includes(book.book_id)} onChange={e => setSelected(current => e.currentTarget.checked ? [...current.filter(id => id !== book.book_id), book.book_id] : current.filter(id => id !== book.book_id))} />
            <BookCover book_id={book.book_id} title={book.title} author={book.author} cover_url={book.cover_url} class="kindle-book-cover" />
            <div class="kindle-library-title"><strong>{book.title}</strong><p class="kindle-small">{book.author || "作者未知"}{book.read ? " · 已读" : " · 未读"}</p></div>
            <span class="kindle-on-device">{onDevice().has(book.book_id) ? "已在设备" : ""}</span><span class="kindle-list-size kindle-mono">{onDevice().has(book.book_id) ? bytes(onDevice().get(book.book_id)!.size) : "—"}</span>
          </li>}</For></ul>
          <Show when={totalPages() > 1}><nav aria-label="书库分页" class="kindle-actions"><Button variant="secondary" disabled={currentPage() === 1} onClick={() => setPage(currentPage() - 1)}>上一页</Button><span>{currentPage()} / {totalPages()}</span><Button variant="secondary" disabled={currentPage() === totalPages()} onClick={() => setPage(currentPage() + 1)}>下一页</Button></nav></Show>
        </Show>
        <Show when={!deviceId() || !k.inventory()}><p class="notice">{!k.ready() ? "检测中…" : !deviceId() ? "请先连接并授权 Kindle。" : "正在读取设备清单，完成后显示设备已有书籍。"} <a href="/kindle/connect">连接与切换设备</a></p></Show>
      </section>
      <aside aria-label="传输" class="kindle-aside">
        <h2>设置</h2>
        <div class="form-stack"><Select label="目标设备" disabled><option>{deviceId() ? `${k.state().device!.identity.name}（当前连接）` : "尚未连接设备"}</option></Select>
          <Select label="排版方案" value={profile()} disabled={!deviceId() || profilesBusy()} onChange={e => setProfile(e.currentTarget.value)}><For each={profiles()}>{p => <option value={p.id}>{p.name}</option>}</For></Select>
          <Show when={profileError()}><p class="field-error" role="alert">{profileError()} <Button variant="quiet" size="sm" onClick={() => reloadProfiles(deviceId())}>重试</Button></p></Show>
          <a class="kindle-preview-link" href="/kindle/preview">预览并调整排版方案</a>
          <Checkbox label="写入封面缩略图（有封面时自动写入）" checked disabled />
          <Checkbox label="覆盖设备上的同名书" checked={overwrite()} onChange={e => setOverwrite(e.currentTarget.checked)} />
          <p class="kindle-small">覆盖仅替换 Bindery 记录的同一本书，保留原文件名与 .sdr 阅读记录。其他来源或不同书籍的同名文件会另存副本。</p>
        </div>
        <Show when={notice()}><p class="notice" role="status">{notice()}</p></Show>
        <section class="kindle-queue" aria-label="传输队列"><div class="kindle-section-heading"><h2>队列</h2><span class="kindle-small kindle-mono">{k.items().filter(i => i.state === "完成").length} / {k.items().length} 完成</span></div>
          <ol class="kindle-queue-list"><For each={k.items()} fallback={<li class="muted">选择书籍后开始传输。</li>}>{item => <li class="kindle-queue-item" data-queue-item={item.id}>
            <div class="kindle-section-heading"><strong>{title(item.bookId)}</strong><span class={`kindle-queue-state ${item.state === "失败" ? "is-failed" : item.state === "完成" ? "is-complete" : ""}`}>{item.state}</span></div>
            <p class="kindle-small">目标：{k.remembered().find(d => d.id === item.deviceId)?.identity.name || item.deviceId}</p>
            <progress class={item.state === "完成" ? "is-complete" : ""} aria-label={`${title(item.bookId)} 传输进度`} max={1} value={item.state === "完成" ? 1 : item.state === "等待" || item.state === "失败" ? 0 : undefined} />
            <p class="kindle-small" role="status">{item.message}</p>
            <Show when={item.state !== "完成" && item.state !== "失败"}><Button variant="quiet" size="sm" onClick={() => k.cancel(item.id)}>取消</Button></Show>
          </li>}</For></ol>
          <div class="kindle-actions"><Button variant="quiet" disabled={!active().length} onClick={() => active().forEach(i => k.cancel(i.id))}>取消所有未完成</Button><Button class="kindle-start-transfer" disabled={!deviceId() || !k.inventory() || !chosen().length || profilesBusy() || k.busy()} onClick={start}>开始传输（{chosen().length}）</Button></div><div class="kindle-actions"><Button variant="quiet" disabled={!k.items().some(i => i.state === "完成" || i.state === "失败")} onClick={k.clearFinished}>清除已结束</Button></div>
        </section>
        <p class="kindle-small">EPUB 从书库下载，在浏览器内由 boko Web Worker 转换 KFX，再经 USB 写入 Kindle。切换 Kindle 标签页时队列继续；刷新或关闭网页会中断传输。转换阶段无法提供精确百分比。</p>
        <a class="kindle-small" href="#boko-license">boko 许可证与对应源码</a>
      </aside>
    </div>
    <BokoLicense />
  </>;
}
