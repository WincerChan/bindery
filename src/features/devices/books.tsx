import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { deleteBook } from "../../client/devices";
import type { DeviceBook } from "../../client/devices/inventory";
import type { PairedDevice } from "../../client/devices/identity";
import { EntryAccessError, entryOperation } from "../../client/devices/fs";
import { BookCover, Button, Checkbox, Chip, ConfirmDialog, EmptyState, TextField } from "../../ui";
import { useDevice } from "./context";
import { bytes, dateLabel, readingTimeLabel } from "./format";
import { koboBookFilename } from "../../client/devices/paths";
import { defaultProfile, DEFAULT_PROFILE_ID, isDefaultSettings } from "../../client/devices/profiles";
import { KindleIcon } from "../kindle/icons";
import { Link } from "../../shared/spa-link";
import { createDeviceLibraryResolver, type DeviceLibraryBook, type DeviceLibraryResolver } from "./library";

function DeviceCover(props: { book: DeviceBook; title: string; author: string | null; libraryCover?: string | null; libraryId?: string | null }) {
  const k = useDevice(), [url, setUrl] = createSignal<string | null>(null);
  onSettled(() => {
    let alive = true, objectUrl: string | undefined;
    const root = k.state().device?.root, record = props.book.record, thumbnail = record && "thumbnail" in record ? record.thumbnail : null;
    if (root && thumbnail) void (async () => {
      try {
        const file = await entryOperation(root, `system/thumbnails/${thumbnail}`, async () => {
          const system = await root.getDirectoryHandle("system"), dir = await system.getDirectoryHandle("thumbnails");
          return (await dir.getFileHandle(thumbnail)).getFile();
        });
        if (alive) { objectUrl = URL.createObjectURL(file); setUrl(objectUrl); }
      } catch (error) { if (!(error instanceof EntryAccessError)) await k.manager.probe(); }
    })();
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  });
  return <BookCover book_id={props.libraryId || props.book.book_id || props.book.record?.book_id || props.book.filename} title={props.title} author={props.author} cover_url={url() || props.libraryCover} class="kindle-book-cover" />;
}

const bookTitle = (filename: string) => filename.split("/").at(-1)!.replace(/\.kepub\.epub$/i, "").replace(/\.[^.]+$/, "");
const deviceNoun = (kind: string | null | undefined) => kind === "kobo" ? "Kobo" : "Kindle";
// Books sent without a tweak keep the built-in label current; a recorded tweak keeps its snapshot name.
const profileName = (book: DeviceBook) => {
  const record = book.record;
  if (!record || !("profile_name" in record)) return null;
  const settings = "settings" in record ? record.settings : undefined;
  return record.profile_id === DEFAULT_PROFILE_ID && (settings === undefined || isDefaultSettings(settings)) ? defaultProfile().name : record.profile_name;
};
const progressLabel = (book: DeviceBook, kind: string) => {
  const progress = book.progress;
  if (!progress || !progress.last_read_at && !progress.percent) return "未读";
  if (kind !== "kindle" && (progress.read_status === 2 || progress.percent >= 100)) return "已读完";
  const time = readingTimeLabel(progress.last_read_at);
  return `在读 ${Math.round(progress.percent)}%${time ? ` · ${time}` : ""}`;
};

/** `chapters`: the chapter each book was last read at on a device, as synced to the server (shown on hover). */
export function DeviceBooksPage(props: { books: DeviceLibraryBook[]; chapters?: (deviceId: string) => Promise<Record<string, string>> }) {
  const k = useDevice(), [source, setSource] = createSignal("全部"), [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string[]>([]), [notice, setNotice] = createSignal("");
  const [notRemoved, setNotRemoved] = createSignal<import("../../client/devices/fs").UnreadableEntry[]>([]);
  const [pending, setPending] = createSignal<{ device: PairedDevice; books: DeviceBook[] } | null>(null);
  const kind = () => k.kind(), kindle = () => kind() === "kindle";
  const selectionDevice = createMemo(() => k.state().device?.identity.id || "");
  createEffect(selectionDevice, () => { setSelected([]); setPending(null); setNotice(""); setNotRemoved([]); });
  const [resolver, setResolver] = createSignal<DeviceLibraryResolver | null>(null);
  createEffect(() => [props.books, kind()] as const, ([books, deviceKind]) => {
    let alive = true; setResolver(null);
    createDeviceLibraryResolver(books, deviceKind).then(value => { if (alive) setResolver(() => value); }, () => { if (alive) setResolver(null); });
    return () => { alive = false; };
  });
  const resolvedId = (book: DeviceBook) => resolver()?.match(book) ?? book.book_id ?? book.record?.book_id ?? null;
  // Positions reach the server through the reading sync, so chapters are fetched again after each pass.
  const [chapters, setChapters] = createSignal<Record<string, string>>({});
  const chapterSource = createMemo(() => k.ready() && k.state().status === "granted" && k.syncSummary() !== "正在同步阅读进度…" ? `${selectionDevice()}\n${k.syncSummary()}` : "");
  createEffect(chapterSource, source => {
    const deviceId = source.split("\n")[0];
    setChapters({});
    if (!deviceId || !props.chapters) return;
    let current = true;
    props.chapters(deviceId).then(value => { if (current) setChapters(value); }, () => { /* The percentage alone still shows. */ });
    return () => { current = false; };
  });
  const chapterTitle = (book: DeviceBook) => { const id = resolvedId(book), chapter = book.progress && id ? chapters()[id] : undefined; return chapter ? `读到：${chapter}` : undefined; };
  const library = createMemo(() => new Map(props.books.map(b => [b.book_id, b])));
  const koboFallback = createMemo(() => {
    const groups = new Map<string, DeviceLibraryBook[]>();
    for (const book of props.books) {
      const key = `Bindery/${koboBookFilename(book.title)}`.toLowerCase();
      groups.set(key, [...groups.get(key) || [], book]);
    }
    return new Map([...groups].filter(([, books]) => books.length === 1).map(([key, books]) => [key, books[0]!]));
  });
  const metadata = (book: DeviceBook) => library().get(resolvedId(book) || "") ?? (kindle() ? undefined : koboFallback().get(book.filename.toLowerCase()));
  const title = (book: DeviceBook) => metadata(book)?.title || bookTitle(book.filename);
  const all = () => k.inventory()?.books || [];
  const visible = () => all().filter(b => (source() === "全部" || b.source === source()) && `${title(b)} ${metadata(b)?.author || ""} ${b.filename}`.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()));
  const deletable = (book: DeviceBook) => kindle() || book.source === "Bindery";
  const deletableVisible = () => visible().filter(deletable);
  const selectedBooks = () => all().filter(b => selected().includes(b.filename) && deletable(b));
  const connected = () => k.ready() && k.state().status === "granted";
  function confirm(books: DeviceBook[]) { const device = k.state().device; if (connected() && device && books.length) { setNotRemoved([]); setPending({ device, books }); } }
  async function remove() {
    const request = pending(); if (!request) return;
    const current = k.manager.snapshot();
    if (current.status !== "granted" || current.device?.identity.id !== request.device.identity.id) throw new Error("设备已切换或断开，请重新选择要删除的书籍");
    try {
      for (const book of request.books) {
        const report = await deleteBook(request.device, book.filename);
        setNotRemoved(current => [...current, ...report.notRemoved]);
        setSelected(current => current.filter(n => n !== book.filename));
        setPending(current => current ? { ...current, books: current.books.filter(b => b.filename !== book.filename) } : null);
      }
      setNotice(`已删除 ${request.books.length} 本设备书籍。${kind() === "kobo" ? "设备下次连接或重启时会更新书架。" : ""}`);
    } finally { await k.refreshInventory(); await k.manager.probe(); }
  }
  function resend(book: DeviceBook) {
    void k.run(async () => {
      const record = book.record, id = resolvedId(book);
      if (!record || !id || !metadata(book)) throw new Error("这本书已不在当前书库，无法重新传入");
      const settings = "settings" in record ? record.settings : undefined;
      k.enqueue(id, "profile_id" in record ? record.profile_id : DEFAULT_PROFILE_ID, settings === undefined ? { overwrite: true } : { overwrite: true, settings });
      const copies = all().filter(b => resolvedId(b) === id).length;
      setNotice(`已加入传输队列：${title(book)}${copies > 1 ? "（将覆盖此书首份 Bindery 副本）" : ""}`);
    });
  }
  return <section aria-label="设备书籍" class="kindle-books">
    <div class="kindle-toolbar kindle-books-toolbar">
      <div class="kindle-section-heading"><h2>书籍</h2><span class="kindle-count kindle-mono">{all().length} 本 · {bytes(k.inventory()?.usage.books || 0)}</span></div>
      <div class="kindle-filters" role="group" aria-label="按来源筛选"><For each={["全部", "Bindery", "其他"]}>{value => <Chip variant="filter" selected={source() === value} onClick={() => { setSource(value); setSelected([]); }}>{value === "Bindery" ? "来自 Bindery" : value}{value !== "全部" ? ` ${all().filter(b => b.source === value).length}` : ""}</Chip>}</For></div>
      <div class="kindle-toolbar-actions">
        <TextField class="kindle-search" label="搜索设备上的书" labelHidden type="search" placeholder="搜索书名或作者" value={query()} onInput={e => { setQuery(e.currentTarget.value); setSelected([]); }} />
        <Button variant="quiet-danger" disabled={!connected() || !selectedBooks().length || k.busy()} onClick={() => confirm(selectedBooks())}>删除所选（{selectedBooks().length}）</Button><Link class="btn btn-primary" href="/devices/transfer">从书库传书</Link>
      </div>
    </div>
    <Show when={notice()}><p role="status" class="notice">{notice()} <Link href="/devices/transfer">查看传输队列</Link></p></Show>
    <Show when={notRemoved().length}>
      <details open class="kindle-small kindle-entry-notice" data-delete-report>
        <summary>书籍文件已删除，以下 {notRemoved().length} 个条目未能删除</summary>
        <p>可在设备本机上或使用支持长路径的工具删除这些残留文件。</p>
        <ul><For each={notRemoved()}>{entry => <li><span class="kindle-mono">{entry.path}</span>（{entry.reason}；{entry.likelyCause}）</li>}</For></ul>
      </details>
    </Show>
    <div class="kindle-table-scroll"><table class="kindle-book-table"><thead><tr>
      <th scope="col"><Checkbox label="" aria-label="全选当前筛选书籍" disabled={!connected() || !deletableVisible().length || k.busy()} checked={deletableVisible().length > 0 && deletableVisible().every(b => selected().includes(b.filename))} indeterminate={deletableVisible().some(b => selected().includes(b.filename)) && !deletableVisible().every(b => selected().includes(b.filename))} onChange={e => setSelected(e.currentTarget.checked ? deletableVisible().map(b => b.filename) : [])} /></th>
      <th scope="col">书籍</th><th scope="col">来源</th><th scope="col">格式</th><th scope="col">阅读进度</th><Show when={kindle()}><th scope="col">排版方案</th></Show><th scope="col">大小</th><Show when={kindle()}><th scope="col">传入时间</th></Show><th scope="col">操作</th>
    </tr></thead><tbody><Show when={connected() && k.inventory()}><For each={visible()}>{book => <tr data-device-book={book.filename}>
      <td><Checkbox label="" aria-label={`选择 ${title(book)}`} disabled={!deletable(book)} checked={selected().includes(book.filename)} onChange={e => setSelected(current => e.currentTarget.checked ? [...current.filter(n => n !== book.filename), book.filename] : current.filter(n => n !== book.filename))} /></td>
      <td><div class="kindle-book-info"><DeviceCover book={book} title={title(book)} author={metadata(book)?.author || null} libraryCover={metadata(book)?.cover_url} libraryId={resolvedId(book)} /><div><strong title={book.filename}>{title(book)}</strong><p class="kindle-small">{metadata(book)?.author || book.filename}</p></div></div></td>
      <td>{book.source}</td><td class="kindle-mono">{book.format.toUpperCase()}</td><td class="kindle-mono" data-device-progress title={chapterTitle(book)}>{progressLabel(book, kind())}</td><Show when={kindle()}><td>{profileName(book) || "—"}</td></Show><td class="kindle-mono">{bytes(book.size)}</td><Show when={kindle()}><td class="kindle-mono kindle-time">{dateLabel(book.record?.transferred_at || null)}</td></Show>
      <td><div class="kindle-row-actions"><Show when={book.record}><Show when={resolvedId(book)}><Link class="btn btn-icon" href={`/devices/preview?book=${encodeURIComponent(resolvedId(book)!)}`} aria-label={`预览 ${title(book)}`} title={`预览 ${title(book)}`}><KindleIcon name="eye" /></Link></Show><Button variant="icon" aria-label={`重新传入 ${title(book)}`} title="使用记录中的排版方案，覆盖此书首份 Bindery 副本并保留其阅读记录" disabled={k.busy() || !resolvedId(book) || !metadata(book)} onClick={() => resend(book)}><KindleIcon name="redo" /></Button></Show><Button variant="icon" aria-label={`从设备删除 ${title(book)}`} title={deletable(book) ? `从设备删除 ${title(book)}` : "只能删除 Bindery 管理的 KEPUB"} disabled={k.busy() || !deletable(book)} onClick={() => confirm([book])}><KindleIcon name="trash" /></Button></div></td>
    </tr>}</For></Show></tbody></table></div>
    <Show when={connected()} fallback={<EmptyState title={k.ready() ? "请先连接设备" : "检测中…"}><Link href="/devices/connect">连接并授权设备</Link>后，可查看和管理设备上的书籍。</EmptyState>}>
      <Show when={k.inventory()} fallback={<p class="muted" role="status">{k.inventoryError() || "正在读取设备书籍…"}</p>}>
        <Show when={!visible().length}><EmptyState title={all().length ? "没有符合条件的书籍" : "设备上还没有书籍"}>{all().length ? "试试其他来源或搜索词。" : <Link href="/devices/transfer">从书库选择书籍传入</Link>}</EmptyState></Show>
      </Show>
    </Show>
    <p class="kindle-table-note">显示 <span class="kindle-mono">{connected() ? visible().length : 0} / {all().length}</span> 本 · {kind() === "kobo" ? "读取 Bindery/ 与设备上的 EPUB / KEPUB；Bindery 传的书标为「来自 Bindery」" : "读取 documents/，删除时一并清理对应的 .sdr 阅读记录"}</p>
    <ConfirmDialog open={pending() !== null} title={`删除 ${deviceNoun(kind())} 上的书籍？`} danger confirmLabel="确认删除" onClose={() => setPending(null)} onConfirm={remove}>
      <Show when={kindle()} fallback={<><p>将从 {deviceNoun(kind())} 的 Bindery/ 删除所选 {pending()?.books.length || 0} 本 KEPUB。设备下次连接或重启时会更新书架；书库中的原书保留。</p><p class="kindle-small">只会删除 Bindery 管理的文件，不会修改 KoboReader.sqlite。</p></>}>
        <p>将从 Kindle 删除所选 {pending()?.books.length || 0} 本书，以及匹配的 .sdr 文件夹（阅读位置、标注等阅读记录）和 Bindery 写入且不再被其他副本使用的封面缩略图。此操作无法撤销；书库中的原书保留。</p>
        <p class="kindle-small">其他来源的封面无法可靠匹配，不会猜测或删除。</p>
      </Show>
      <ul><For each={pending()?.books || []}>{book => <li>{title(book)}</li>}</For></ul>
    </ConfirmDialog>
  </section>;
}
export const KindleBooksPage = DeviceBooksPage;
