import { createEffect, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { BookCover, Button, Dialog, Select, TextField } from "../../ui";
import { contentUrl, defaultSettings, highlightedParts, initialPosition, normalizeSettings, sectionUrl, type ReaderData, type ReaderSettings, type SearchHit, type SearchResults } from "./model";
import { ReaderFrames } from "./frame";
import { ProgressWriter } from "./progress";

export function Reader(props: { data: ReaderData; query: URLSearchParams }) {
  // Resume/query seed this reader session once; subsequent turns belong to ReaderFrames.
  const initial = untrack(() => initialPosition(props.data, props.query)), book = () => props.data.book;
  const [position, setPosition] = createSignal({ section: initial.section, page: Math.min(initial.page, 999_999), pageCount: 1, frame: 0 });
  const [settings, setSettings] = createSignal<ReaderSettings>({ ...defaultSettings });
  const [tocOpen, setTocOpen] = createSignal(false), [settingsOpen, setSettingsOpen] = createSignal(false), [searchOpen, setSearchOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(true), [error, setError] = createSignal(""), [progressError, setProgressError] = createSignal("");
  const [query, setQuery] = createSignal(untrack(() => props.query.get("find") || "")), [results, setResults] = createSignal<SearchResults | null>(null), [searchBusy, setSearchBusy] = createSignal(false), [searchError, setSearchError] = createSignal("");
  const [clock, setClock] = createSignal("");
  let a!: HTMLIFrameElement, b!: HTMLIFrameElement, c!: HTMLIFrameElement, controller: ReaderFrames | undefined, writer: ProgressWriter | undefined, searchRequest: AbortController | undefined;
  let cleanup: (() => void) | undefined, disposed = false, firstPosition = true;
  const current = () => props.data.sections[position().section];
  const detailUrl = () => `/book/${book().book_id}${props.data.return_to === "/" ? "" : `?${new URLSearchParams({ return_to: props.data.return_to })}`}`;
  const url = (section: number, extra: Record<string, string> = {}) => sectionUrl(book().book_id, section, props.data.return_to, extra);
  const updateSetting = <K extends keyof ReaderSettings>(name: K, value: ReaderSettings[K]) => setSettings(old => normalizeSettings({ ...old, [name]: value }));
  function openSection(section: number, page = 1, find = "") {
    controller?.open(section, page, find); setTocOpen(false); setSearchOpen(false);
  }
  onSettled(() => {
    if (typeof window === "undefined" || disposed || controller) return;
    try { setSettings(normalizeSettings(JSON.parse(localStorage.getItem("bindery:reader") || "null"))); } catch { /* storage can be disabled */ }
    writer = new ProgressWriter(book().book_id, setProgressError);
    controller = new ReaderFrames(props.data, [a, b, c], initial, value => {
      setPosition(value); writer!.queue(value.section, value.page, value.pageCount);
      const next = new URL(url(value.section), window.location.href);
      if (!firstPosition && window.location.pathname !== next.pathname) history.pushState(history.state, "", `${next.pathname}${next.search}`);
      else if (window.location.pathname !== next.pathname || /[?&](?:resume|page|nav|find)=/.test(window.location.search)) {
        history.replaceState(history.state, "", `${next.pathname}${next.search}`);
      }
      firstPosition = false;
    }, setBusy, setError);
    controller.configure(settings());
    if (props.query.get("find")) controller.open(initial.section, initial.page, props.query.get("find")!);
    const key = (event: KeyboardEvent) => { if (!tocOpen() && !settingsOpen() && !searchOpen()) controller?.key(event); };
    const hide = () => { if (document.visibilityState === "hidden") writer?.unload(navigator.sendBeacon.bind(navigator)); };
    const unload = () => writer?.unload(navigator.sendBeacon.bind(navigator));
    const pop = () => {
      const match = new RegExp(`^/book/${book().book_id}/preview/(\\d+)/?$`).exec(window.location.pathname);
      if (match) controller?.open(Number(match[1]));
    };
    const time = () => setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    time(); const timer = setInterval(time, 29_000);
    window.addEventListener("keydown", key); window.addEventListener("pagehide", unload); window.addEventListener("popstate", pop); document.addEventListener("visibilitychange", hide);
    cleanup = () => { clearInterval(timer); window.removeEventListener("keydown", key); window.removeEventListener("pagehide", unload); window.removeEventListener("popstate", pop); document.removeEventListener("visibilitychange", hide); };
  });
  createEffect(() => settings(), value => {
    if (!controller || disposed) return;
    controller.configure(value);
    try { localStorage.setItem("bindery:reader", JSON.stringify(value)); } catch { /* settings still work without storage */ }
  });
  createEffect(() => tocOpen(), open => {
    if (open) requestAnimationFrame(() => document.querySelector(".reader-toc [aria-current=page]")?.scrollIntoView({ block: "center" }));
  });
  onCleanup(() => { disposed = true; cleanup?.(); controller?.destroy(); writer?.destroy(); searchRequest?.abort(); });

  async function runSearch(append = false) {
    const term = append ? results()?.query || query().trim() : query().trim();
    if (!term) { setResults(null); setSearchError(""); return; }
    searchRequest?.abort(); const request = new AbortController(); searchRequest = request;
    setSearchBusy(true); setSearchError("");
    const params = new URLSearchParams({ q: term, limit: "10", offset: String(append ? results()?.next_offset || 0 : 0) });
    try {
      const response = await fetch(`/book/${book().book_id}/search?${params}`, { signal: request.signal, credentials: "same-origin", headers: { Accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "检索失败");
      if (request.signal.aborted || disposed) return;
      setResults({ ...payload, hits: append ? [...(results()?.hits || []), ...payload.hits] : payload.hits });
    } catch (error) {
      if (!request.signal.aborted && !disposed) { setSearchError(error instanceof Error ? error.message : "检索失败"); if (!append) setResults(null); }
    } finally { if (!request.signal.aborted && !disposed) setSearchBusy(false); }
  }
  const hitHref = (hit: SearchHit) => url(hit.index, { find: results()?.query || query() });
  return <article class="reader-page" aria-label={`阅读 ${book().title}`}>
    <header class="reader-toolbar">
      <a class="btn btn-quiet" href={detailUrl()}>返回详情</a>
      <div class="reader-heading"><h1>{book().title}</h1><p>{current()?.title}</p></div>
      <Button variant="secondary" aria-haspopup="dialog" aria-expanded={tocOpen() ? "true" : "false"} onClick={() => setTocOpen(true)}>目录</Button>
      <Button variant="quiet" aria-haspopup="dialog" onClick={() => setSearchOpen(true)}>全文检索</Button>
      <Button variant="quiet" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>设置</Button>
    </header>
    <div class="reader-stage" aria-busy={busy() ? "true" : "false"}>
      <iframe ref={a} class={`reader-frame ${position().frame === 0 ? "is-active" : ""}`} title="阅读正文" sandbox="allow-same-origin" referrerpolicy="no-referrer" src={contentUrl(book().book_id, props.data.sections[initial.section].item_path)} aria-hidden={position().frame !== 0 ? "true" : "false"} tabindex={position().frame === 0 ? 0 : -1} />
      <iframe ref={b} class={`reader-frame ${position().frame === 1 ? "is-active" : ""}`} title="预载章节一" sandbox="allow-same-origin" referrerpolicy="no-referrer" aria-hidden={position().frame !== 1 ? "true" : "false"} tabindex={position().frame === 1 ? 0 : -1} />
      <iframe ref={c} class={`reader-frame ${position().frame === 2 ? "is-active" : ""}`} title="预载章节二" sandbox="allow-same-origin" referrerpolicy="no-referrer" aria-hidden={position().frame !== 2 ? "true" : "false"} tabindex={position().frame === 2 ? 0 : -1} />
      <Show when={busy()}><p class="reader-loading" role="status">正在加载章节…</p></Show>
      <Show when={error()}><div class="reader-load-error" role="alert"><p>{error()}</p><Button variant="secondary" onClick={() => controller?.retry()}>重试</Button></div></Show>
      <noscript><p>启用 JavaScript 后可翻页和保存阅读进度。<a href={contentUrl(book().book_id, current().item_path)}>打开当前章节</a></p></noscript>
    </div>
    <footer class="reader-footer">
      <Button variant="secondary" disabled={busy() || (position().section === 0 && position().page <= 1)} aria-label="上一页（手机左侧翻页）" onClick={() => controller?.turn(-1)}>上一页</Button>
      <span role="status" aria-live="polite">{position().page} / {position().pageCount} 页 · {position().section + 1} / {props.data.sections.length} 章</span>
      <Button variant="secondary" disabled={busy() || (position().section === props.data.sections.length - 1 && position().page >= position().pageCount)} aria-label="下一页（手机右侧翻页）" onClick={() => controller?.turn(1)}>下一页</Button>
      <time class="reader-clock">{clock()}</time>
    </footer>
    <Show when={progressError()}><p role="status" class="reader-save-error">{progressError()}</p></Show>
    <nav class="reader-chapter-nav" aria-label="章节导航">
      <Show when={position().section > 0}><a href={url(position().section - 1, { page: "last" })} onClick={event => { if (controller) { event.preventDefault(); openSection(position().section - 1, Number.MAX_SAFE_INTEGER); } }}>上一章</a></Show>
      <a href={detailUrl()}>书籍详情</a>
      <Show when={position().section < props.data.sections.length - 1}><a href={url(position().section + 1)} onClick={event => { if (controller) { event.preventDefault(); openSection(position().section + 1); } }}>下一章</a></Show>
    </nav>
    <Dialog open={tocOpen()} title="目录" class="reader-dialog reader-toc" onClose={() => setTocOpen(false)}>
      <div class="reader-book"><div class="reader-cover"><BookCover {...book()} /></div><div><h3>{book().title}</h3><p>{book().author || "未知"} · 共 {props.data.sections.length} 章</p></div></div>
      <ol><For each={props.data.sections}>{(section, index) => <li><a href={url(index())} data-current-toc={index() === position().section ? "true" : undefined} aria-current={index() === position().section ? "page" : undefined} onClick={event => { if (controller) { event.preventDefault(); openSection(index()); } }}>{section.title}</a></li>}</For></ol>
    </Dialog>
    <Dialog open={settingsOpen()} title="设置" class="reader-dialog" onClose={() => setSettingsOpen(false)}>
      <div class="reader-settings">
        <Select label="样式" value={settings().styleMode} onChange={e => updateSetting("styleMode", e.currentTarget.value as ReaderSettings["styleMode"])}><option value="book">书籍</option><option value="custom">自定义</option></Select>
        <Select label="亮度" value={settings().brightnessMode} onChange={e => updateSetting("brightnessMode", e.currentTarget.value as ReaderSettings["brightnessMode"])}><option value="bright">亮色</option><option value="dim">暗色</option></Select>
        <Select label="背景" value={settings().readerBg} onChange={e => updateSetting("readerBg", e.currentTarget.value as ReaderSettings["readerBg"])}><option value="book">书籍</option><option value="paper">纸张</option><option value="sand">暖砂</option><option value="mint">薄荷</option><option value="slate">雾灰</option></Select>
        <Select label="字体" value={settings().fontFamily} disabled={settings().styleMode === "book"} onChange={e => updateSetting("fontFamily", e.currentTarget.value as ReaderSettings["fontFamily"])}><option value="serif">宋体</option><option value="sans">黑体</option><option value="kai">楷体</option><option value="mono">等宽</option></Select>
        <TextField label="字号" type="number" min={11} max={28} value={settings().fontSize} disabled={settings().styleMode === "book"} onChange={e => updateSetting("fontSize", Number(e.currentTarget.value))} />
        <TextField label="行高" type="number" min={1.2} max={2.4} step={0.05} value={settings().lineHeight} disabled={settings().styleMode === "book"} onChange={e => updateSetting("lineHeight", Number(e.currentTarget.value))} />
        <Select label="对齐" value={settings().textAlignMode} disabled={settings().styleMode === "book"} onChange={e => updateSetting("textAlignMode", e.currentTarget.value as ReaderSettings["textAlignMode"])}><option value="justify">两端对齐</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></Select>
        <TextField label="左右边距" type="number" min={-1} max={48} step={2} value={settings().pagePaddingX} disabled={settings().styleMode === "book"} onChange={e => updateSetting("pagePaddingX", Number(e.currentTarget.value))} />
        <TextField label="上下边距" type="number" min={-1} max={48} step={2} value={settings().pagePaddingY} disabled={settings().styleMode === "book"} onChange={e => updateSetting("pagePaddingY", Number(e.currentTarget.value))} />
      </div>
    </Dialog>
    <Dialog open={searchOpen()} title="全文检索" class="reader-dialog" onClose={() => setSearchOpen(false)}>
      <form class="reader-search-form" onSubmit={event => { event.preventDefault(); void runSearch(); }}><TextField label="关键词" type="search" maxlength={200} value={query()} onInput={e => setQuery(e.currentTarget.value)} /><Button type="submit" disabled={searchBusy()}>{searchBusy() ? "检索中…" : "检索"}</Button></form>
      <Show when={searchError()}><p role="alert" class="field-error">{searchError()}</p></Show>
      <Show when={results()}><p role="status">已检索 {results()!.indexed_sections} 个章节 · 找到 {results()!.hits.length} 条结果</p><Show when={!results()!.hits.length}><p>没有找到匹配内容</p></Show></Show>
      <ol class="reader-search-results"><For each={results()?.hits || []}>{hit => <li><a href={hitHref(hit)} onClick={event => { if (controller) { event.preventDefault(); openSection(hit.index, 1, results()?.query || query()); } }}><strong><HighlightedText text={hit.title} query={results()?.query || ""} /></strong><span><HighlightedText text={hit.snippet} query={results()?.query || ""} /></span></a></li>}</For></ol>
      <Show when={results()?.has_more}><Button variant="secondary" disabled={searchBusy()} onClick={() => void runSearch(true)}>加载更多</Button></Show>
    </Dialog>
  </article>;
}
function HighlightedText(props: { text: string; query: string }) {
  return <For each={highlightedParts(props.text, props.query)}>{part => <Show when={part.matched} fallback={part.text}><mark>{part.text}</mark></Show>}</For>;
}
