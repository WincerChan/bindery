import { createEffect, createSignal, createUniqueId, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { useRouter } from "@tanstack/solid-router";
import { BackLink, Button, CloseButton, Icon, IconButton, Popover, ProgressBar, SegmentedControl, SideSheet, Slider } from "../../ui";
import { contentUrl, highlightedParts, initialPosition, normalizeSettings, sectionUrl, storageKey, type ReaderData, type ReaderSettings, type SearchHit, type SearchResults } from "./model";
import { ReaderSettingsControls } from "./reader-settings";
import { readerInitialSettings, readerPaper, readerPercent, readerProgressTarget, resumeFraction } from "./reader-presentation";
import { ReaderFrames } from "./frame";
import { ProgressWriter } from "./progress";

type Panel = "toc" | "search" | "settings";

export function Reader(props: { data: ReaderData; query: URLSearchParams }) {
  // Resume/query seed this session once; subsequent turns belong to ReaderFrames.
  const initial = untrack(() => initialPosition(props.data, props.query)), book = () => props.data.book;
  const initialCount = untrack(() => {
    if (props.query.get("resume") !== "1") return 1;
    const latest = props.data.latest_progress, saved = props.data.initial_progress;
    const progress = latest && latest.section === initial.section ? latest : saved && saved.section === initial.section ? saved : null;
    return progress && "page_count" in progress && typeof progress.page_count === "number" ? Math.max(1, progress.page_count) : 1;
  });
  const fraction = resumeFraction(initial.page, initialCount, initial.fraction);
  const start = { section: initial.section, page: Math.min(initial.page, initialCount), ...(fraction === undefined ? {} : { fraction }) };
  const [position, setPosition] = createSignal({ section: start.section, page: start.page, pageCount: initialCount, frame: 0 });
  const [settings, setSettings] = createSignal<ReaderSettings>(readerInitialSettings());
  const [chromeVisible, setChromeVisible] = createSignal(true);
  const [phone, setPhone] = createSignal(false);
  const [scrub, setScrub] = createSignal<number | null>(null);
  const [panel, setPanel] = createSignal<Panel | null>(null);
  const [chapterFocusPending, setChapterFocusPending] = createSignal(false);
  const [busy, setBusy] = createSignal(true), [error, setError] = createSignal(""), [progressError, setProgressError] = createSignal(""), [saveNotice, setSaveNotice] = createSignal("");
  const [query, setQuery] = createSignal(untrack(() => props.query.get("find") || "")), [results, setResults] = createSignal<SearchResults | null>(null), [searchBusy, setSearchBusy] = createSignal(false), [searchError, setSearchError] = createSignal("");
  const id = createUniqueId();
  let a!: HTMLIFrameElement, b!: HTMLIFrameElement, c!: HTMLIFrameElement, controller: ReaderFrames | undefined, writer: ProgressWriter | undefined, searchRequest: AbortController | undefined;
  let contents!: HTMLDivElement, searchInput!: HTMLInputElement;
  let settingsTrigger!: HTMLButtonElement;
  let chromeTimer: ReturnType<typeof setTimeout> | undefined;
  const sheetOpen = () => panel() === "toc" || panel() === "search";
  const percent = () => readerPercent(position().section, position().page, position().pageCount, props.data.sections.length);
  const roundedPercent = () => Math.round(percent());
  const pageLabel = () => `${position().page} / ${position().pageCount} 跨页`;
  const phonePageLabel = () => `第 ${position().page} 页`;
  const bookSubtitle = () => `${book().author ? `${book().author} · ` : ""}读到 ${roundedPercent()}%`;
  const searchGroups = () => {
    const groups: { index: number; title: string; hits: SearchHit[] }[] = [];
    for (const hit of results()?.hits || []) {
      const last = groups[groups.length - 1];
      if (last && last.index === hit.index) last.hits.push(hit);
      else groups.push({ index: hit.index, title: hit.title, hits: [hit] });
    }
    return groups;
  };
  function revealChrome() {
    setChromeVisible(true); clearTimeout(chromeTimer);
    if (!phone()) chromeTimer = setTimeout(() => {
      if (!panel() && !document.activeElement?.closest("button, a, input, dialog")) setChromeVisible(false);
    }, 3500);
  }
  let cleanup: (() => void) | undefined, disposed = false;
  const current = () => props.data.sections[position().section];
  /**
   * Chapter turns only replace the current entry: the reader already shows the next chapter, while the
   * router patches history.pushState and would treat each chapter URL as a new route (reload, skeleton,
   * remount), and its popstate listener runs before any of ours. `_ignoreSubscribers` is the switch
   * @tanstack/history itself sets around its own writes. Back therefore leaves the book.
   */
  const router = useRouter() as ReturnType<typeof useRouter> | null;
  const silently = (update: () => void) => {
    const history = router?.history as { _ignoreSubscribers?: boolean } | undefined;
    if (!history) { update(); return; }
    history._ignoreSubscribers = true;
    try { update(); } finally { history._ignoreSubscribers = false; }
  };
  const detailUrl = () => `/book/${book().book_id}${props.data.return_to === "/" ? "" : `?${new URLSearchParams({ return_to: props.data.return_to })}`}`;
  const url = (section: number, extra: Record<string, string> = {}) => sectionUrl(book().book_id, section, props.data.return_to, extra);
  function closePanel() { setPanel(null); revealChrome(); }
  const togglePanel = (name: Panel) => { revealChrome(); panel() === name || (name === "toc" && sheetOpen()) ? closePanel() : setPanel(name); };
  function seekProgress() {
    const value = scrub(); setScrub(null);
    if (value === null) return;
    const target = readerProgressTarget(value, props.data.sections.length);
    controller?.open(target.section, 1, "", "", target.fraction);
  }
  function openSection(section: number, page = 1, find = "") {
    setChapterFocusPending(true); controller?.open(section, page, find); closePanel();
  }
  onSettled(() => {
    if (typeof window === "undefined" || disposed || controller) return;
    const media = window.matchMedia("(max-width: 767px)");
    const resize = () => {
      setPhone(media.matches);
      if (media.matches) { clearTimeout(chromeTimer); setChromeVisible(false); } else revealChrome();
    };
    resize();
    if (media.addEventListener) media.addEventListener("change", resize); else media.addListener?.(resize);
    let saved: unknown = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { /* storage can be disabled */ }
    setSettings(saved && typeof saved === "object" && !Array.isArray(saved) ? normalizeSettings(saved) : readerInitialSettings(media.matches));
    writer = new ProgressWriter(book().book_id, setProgressError);
    controller = new ReaderFrames(props.data, [a, b, c], start, value => {
      setPosition(value); writer!.queue(value.section, value.page, value.pageCount);
      const next = new URL(url(value.section), window.location.href);
      if (window.location.pathname !== next.pathname || /[?&](?:resume|page|nav|find)=/.test(window.location.search)) {
        silently(() => history.replaceState(history.state, "", `${next.pathname}${next.search}`));
      }
    }, setBusy, setError, kind => {
      if (panel()) { if (panel() === "settings" && kind === "tap") closePanel(); return false; }
      if (kind === "toggle") setChromeVisible(value => !value); else if (kind === "activity" || kind === "tap" && !phone()) revealChrome();
      return true;
    });
    controller.configure(settings());
    if (props.query.get("find")) controller.open(initial.section, initial.page, props.query.get("find")!);
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (panel()) {
        if (event.key === "Escape") { event.preventDefault(); closePanel(); }
        return;
      }
      if ((event.target as Element | null)?.closest("input, textarea, select, button, a, [contenteditable]")) return;
      // ReaderFrames handles arrows, PageUp/PageDown and Space in both documents.
      if (event.key === "Backspace") {
        event.preventDefault(); controller?.turn(-1);
      } else controller?.key(event);
    };
    // Escape/Backspace also work when keyboard focus is in the sandboxed chapter.
    const removeFrameKeys = [a, b, c].map(frame => {
      let chapter: Document | null = null;
      const backspace = (event: KeyboardEvent) => { if (event.key === "Backspace" || event.key === "Escape") key(event); };
      const loaded = () => {
        chapter?.removeEventListener("keydown", backspace);
        chapter = frame.contentDocument;
        chapter?.addEventListener("keydown", backspace);
      };
      frame.addEventListener("load", loaded); loaded();
      return () => { frame.removeEventListener("load", loaded); chapter?.removeEventListener("keydown", backspace); };
    });
    const hide = () => { if (document.visibilityState === "hidden") writer?.unload(navigator.sendBeacon.bind(navigator)); };
    const unload = () => writer?.unload(navigator.sendBeacon.bind(navigator));
    window.addEventListener("keydown", key); window.addEventListener("pagehide", unload);
    document.addEventListener("visibilitychange", hide);
    cleanup = () => {
      removeFrameKeys.forEach(remove => remove());
      clearTimeout(chromeTimer);
      if (media.removeEventListener) media.removeEventListener("change", resize); else media.removeListener?.(resize);
      window.removeEventListener("keydown", key); window.removeEventListener("pagehide", unload);
      document.removeEventListener("visibilitychange", hide);
    };
  });
  createEffect(() => settings(), value => {
    if (!controller || disposed) return;
    controller.configure(value);
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* settings still work without storage */ }
  });
  createEffect(() => panel(), active => {
    if (!active) return;
    const animation = requestAnimationFrame(() => {
      if (panel() !== active) return;
      if (active === "toc") {
        const link = contents.querySelector<HTMLElement>("[aria-current=page]");
        link?.scrollIntoView({ block: "center" }); link?.focus();
      } else if (active === "search") searchInput.focus();
    });
    return () => cancelAnimationFrame(animation);
  });
  createEffect(() => chapterFocusPending() && !busy() && !panel() ? position().frame : -1, frame => {
    if (frame < 0) return;
    const animation = requestAnimationFrame(() => { [a, b, c][frame].focus(); setChapterFocusPending(false); });
    return () => cancelAnimationFrame(animation);
  });
  createEffect(() => progressError(), message => {
    setSaveNotice(message);
    if (!message) return;
    const timer = setTimeout(() => setSaveNotice(""), 2600);
    return () => clearTimeout(timer);
  });
  onCleanup(() => { disposed = true; cleanup?.(); controller?.destroy(); writer?.destroy(); searchRequest?.abort(); });

  function clearSearch() {
    searchRequest?.abort(); setQuery(""); setResults(null); setSearchError(""); setSearchBusy(false); searchInput.focus();
  }
  async function runSearch(append = false) {
    const term = query().trim();
    if (append && results()?.query !== term) append = false;
    searchRequest?.abort();
    if (!term) { setResults(null); setSearchError(""); setSearchBusy(false); return; }
    const request = new AbortController(); searchRequest = request;
    if (!append) setResults(null);
    setSearchBusy(true); setSearchError("");
    const params = new URLSearchParams({ q: term, limit: "20", offset: String(append ? results()?.next_offset || 0 : 0) });
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
  const previousDisabled = () => busy() || (position().section === 0 && position().page <= 1);
  const nextDisabled = () => busy() || (position().section === props.data.sections.length - 1 && position().page >= position().pageCount);
  return <article class="reader-page" data-paper={readerPaper(settings())} data-chrome={chromeVisible() || panel() ? "visible" : "hidden"} aria-label={`阅读 ${book().title}`} onPointerMove={event => { if (event.pointerType !== "touch" && !phone()) revealChrome(); }}>
    <p class="reader-running-head">{current()?.title}</p>
    <header class="reader-toolbar" aria-label="阅读工具栏">
      <BackLink class="reader-back" href={detailUrl()}><span>{book().title}</span></BackLink>
      <div class="reader-heading" title={current()?.title}>{current()?.title}</div>
      <IconButton aria-label="目录与检索" title="目录与检索" aria-haspopup="dialog" aria-controls={`${id}-contents`} aria-expanded={sheetOpen() ? "true" : "false"} onClick={() => togglePanel("toc")}><Icon name="menu-2" size={20} /></IconButton>
      <IconButton ref={settingsTrigger} class="reader-aa" aria-label="阅读设置" title="阅读设置" aria-haspopup="dialog" aria-controls={`${id}-settings`} aria-expanded={panel() === "settings" ? "true" : "false"} onClick={() => togglePanel("settings")}>Aa</IconButton>
    </header>
    <div class="reader-column" inert={sheetOpen()}>
      <div class="reader-stage" aria-busy={busy() ? "true" : "false"}>
        <iframe ref={a} class={`reader-frame ${position().frame === 0 ? "is-active" : ""}`} title="阅读正文" sandbox="allow-same-origin" referrerpolicy="no-referrer" src={contentUrl(book().book_id, props.data.sections[initial.section].item_path)} aria-hidden={position().frame !== 0 ? "true" : "false"} tabindex={position().frame === 0 ? 0 : -1} />
        <iframe ref={b} class={`reader-frame ${position().frame === 1 ? "is-active" : ""}`} title="预载章节一" sandbox="allow-same-origin" referrerpolicy="no-referrer" aria-hidden={position().frame !== 1 ? "true" : "false"} tabindex={position().frame === 1 ? 0 : -1} />
        <iframe ref={c} class={`reader-frame ${position().frame === 2 ? "is-active" : ""}`} title="预载章节二" sandbox="allow-same-origin" referrerpolicy="no-referrer" aria-hidden={position().frame !== 2 ? "true" : "false"} tabindex={position().frame === 2 ? 0 : -1} />
        <Show when={busy()}><p class="reader-loading" role="status">章节切换中...</p></Show>
        <Show when={error()}><div class="reader-load-error" role="alert"><p>{error()}</p><Button variant="secondary" onClick={() => controller?.retry()}>重试</Button></div></Show>
        <noscript><p>启用 JavaScript 后可翻页和保存阅读进度。<a href={contentUrl(book().book_id, current().item_path)}>打开当前章节</a></p></noscript>
      </div>
    </div>
    <footer class="reader-status" aria-label="阅读位置">
      <p class="reader-folio" role="status">
        <span class="reader-folio-desktop">{pageLabel()}<span class="reader-folio-desktop-percent"> · {roundedPercent()}%</span></span>
        <span class="reader-folio-phone"><span aria-hidden="true">{position().page}</span><span class="sr-only">第 {position().page} 页，共 {position().pageCount} 页</span></span>
        <span class="reader-folio-percent" aria-hidden="true">{roundedPercent()}%</span>
      </p>
      <div class="reader-desktop-progress"><ProgressBar label="全书进度（按章节估算）" value={percent()} /><span>{roundedPercent()}%</span></div>
      <div class="reader-mobile-controls">
        <div class="reader-chapter-step">
          <IconButton aria-label="上一章" title={props.data.sections[position().section - 1]?.title || "已是第一章"} disabled={busy() || position().section === 0} onClick={() => openSection(position().section - 1)}><Icon name="chevron-left" size={18} /></IconButton>
          <div><strong>{current()?.title}</strong><span>{phonePageLabel()}<span class="sr-only">，共 {position().pageCount} 页</span></span></div>
          <IconButton aria-label="下一章" title={props.data.sections[position().section + 1]?.title || "已是最后一章"} disabled={busy() || position().section === props.data.sections.length - 1} onClick={() => openSection(position().section + 1)}><Icon name="chevron-right" size={18} /></IconButton>
        </div>
        <div class="reader-scrubber" onChange={seekProgress} onPointerUp={seekProgress} onKeyUp={seekProgress}>
          <Slider label="全书进度（按章节估算）" value={scrub() ?? percent()} step={0.1} formatValue={value => `${Math.round(value)}%`} onChange={setScrub} />
        </div>
      </div>
    </footer>
    <IconButton class="reader-page-turn reader-page-previous" disabled={previousDisabled()} aria-label="上一页" title="上一页（← / PageUp / Backspace）" hidden={panel() !== null} onClick={() => controller?.turn(-1)}><Icon name="chevron-left" size={20} /></IconButton>
    <IconButton class="reader-page-turn reader-page-next" disabled={nextDisabled()} aria-label="下一页" title="下一页（→ / PageDown / 空格）" hidden={panel() !== null} onClick={() => controller?.turn(1)}><Icon name="chevron-right" size={20} /></IconButton>
    <Button variant="quiet" class="reader-chrome-toggle" aria-label={chromeVisible() ? "隐藏工具栏" : "显示工具栏"} aria-expanded={chromeVisible() ? "true" : "false"} onClick={() => setChromeVisible(value => !value)}>工具栏</Button>
    <Show when={saveNotice()}><p role="status" class="reader-save-notice">{saveNotice()}</p></Show>
    <SideSheet id={`${id}-contents`} open={sheetOpen()} side="left" class="reader-contents" title="目录与检索" closeLabel="关闭目录与检索" heading={false} onClose={closePanel}>
      <div ref={contents} class="reader-sheet-panel" data-panel={panel()}>
        <div class="reader-sheet-head">
          <SegmentedControl class="reader-sheet-tabs" label="目录与检索" value={panel() === "search" ? "search" : "toc"} options={[{ value: "toc", label: "目录" }, { value: "search", label: "检索" }]} onChange={value => setPanel(value as Panel)} />
          <Show when={panel() === "toc" || phone()}><div class="reader-sheet-book"><p class="reader-sheet-title">{book().title}</p><p class="reader-sheet-sub">{bookSubtitle()}</p></div></Show>
          <CloseButton class="reader-sheet-close" aria-label="关闭目录与检索" title="关闭" onClick={closePanel} />
        </div>
        <nav class="reader-toc" aria-label="章节目录" hidden={panel() === "search"}><ol><For each={props.data.sections}>{(section, index) => <li><a href={url(index())} title={section.title} aria-current={index() === position().section ? "page" : undefined} onClick={event => { if (controller && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openSection(index()); } }}><span class="reader-toc-number" aria-hidden="true">{String(index() + 1).padStart(2, "0")}</span><span>{section.title}</span><Show when={index() === position().section}><span class="reader-current">正在读</span></Show></a></li>}</For></ol></nav>
        <section class="reader-search" aria-label="全文检索" hidden={panel() !== "search"}>
          <form class="reader-search-form" role="search" aria-label="全文检索" onSubmit={event => { event.preventDefault(); void runSearch(); }}>
            <Icon name="search" size={16} />
            <input ref={searchInput} type="search" aria-label="在全书中检索" maxlength={200} placeholder="在全书中检索，回车开始" value={query()} onInput={event => setQuery(event.currentTarget.value)} />
            <button type="button" class="reader-search-clear" aria-label="清空" title="清空" onClick={clearSearch}><Icon name="x" size={14} /></button>
            <button type="submit" hidden disabled={searchBusy() || !query().trim()}>开始检索</button>
          </form>
          <Show when={results() && !searchBusy()}><p class="reader-search-summary" role="status"><span>找到</span><strong>{results()!.hits.length}</strong><span>处，已索引 {results()!.indexed_sections} 节</span></p></Show>
          <Show when={searchError()}><p role="alert" class="field-error">{searchError()}</p></Show>
          <div class="reader-search-content">
            <ol class="reader-search-results"><For each={searchGroups()}>{group => <li class="reader-search-group"><p class="reader-search-group-head">{group.title}<span class="reader-search-group-count">{group.hits.length} 处</span><Show when={group.index === position().section}><span class="reader-current">正在读</span></Show></p><For each={group.hits}>{hit => <a href={hitHref(hit)} onClick={event => { if (controller && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openSection(hit.index, 1, results()?.query || query()); } }}><span class="sr-only">{hit.title}：</span><HighlightedText text={hit.snippet} query={results()?.query || ""} /></a>}</For></li>}</For></ol>
            <Show when={results() && !results()!.hits.length && !searchBusy()}><p class="reader-search-empty">未命中</p></Show>
            <Show when={searchBusy()}><p role="status" class="reader-search-empty">检索中…</p></Show>
          </div>
          <Show when={results()?.has_more}><Button variant="secondary" class="reader-search-more" disabled={searchBusy()} onClick={() => void runSearch(true)}>再显示 20 处</Button></Show>
        </section>
      </div>
    </SideSheet>
    <Popover id={`${id}-settings`} open={panel() === "settings"} class="reader-settings" title="排版" closeLabel="关闭排版设置" heading={phone()} align="end" anchor={() => settingsTrigger} onClose={closePanel}>
      <ReaderSettingsControls value={settings()} onChange={value => setSettings(normalizeSettings(value))} />
    </Popover>
  </article>;
}

function HighlightedText(props: { text: string; query: string }) {
  return <For each={highlightedParts(props.text, props.query)}>{part => <Show when={part.matched} fallback={part.text}><mark>{part.text}</mark></Show>}</For>;
}
