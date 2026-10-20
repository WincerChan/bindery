import { createEffect, createSignal, createUniqueId, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { BookCover, Button } from "../../ui";
import { Link } from "../../shared/spa-link";
import { contentUrl, defaultSettings, highlightedParts, initialPosition, normalizeSettings, sectionUrl, type ReaderData, type ReaderSettings, type SearchHit, type SearchResults } from "./model";
import { ReaderFrames } from "./frame";
import { ProgressWriter } from "./progress";

type Panel = "toc" | "search" | "settings";
// Python's controls have narrower limits than its persisted-settings validator.
const backgrounds = [{ value: "book", label: "书籍" }, { value: "slate", label: "灰白" }, { value: "paper", label: "纸张" }, { value: "sand", label: "砂岩" }, { value: "mint", label: "薄荷" }] as const;
const lineHeights = [1.55, 1.65, 1.75, 1.85, 1.95, 2.05];

export function Reader(props: { data: ReaderData; query: URLSearchParams }) {
  // Resume/query seed this session once; subsequent turns belong to ReaderFrames.
  const initial = untrack(() => initialPosition(props.data, props.query)), book = () => props.data.book;
  const initialCount = untrack(() => props.query.get("resume") === "1" && props.data.initial_progress?.section === initial.section ? Math.max(1, props.data.initial_progress.page_count) : 1);
  const [position, setPosition] = createSignal({ section: initial.section, page: Math.min(initial.page, initialCount), pageCount: initialCount, frame: 0 });
  const [settings, setSettings] = createSignal<ReaderSettings>({ ...defaultSettings });
  const [panel, setPanel] = createSignal<Panel | null>(null);
  const [chapterFocusPending, setChapterFocusPending] = createSignal(false);
  const [busy, setBusy] = createSignal(true), [error, setError] = createSignal(""), [progressError, setProgressError] = createSignal(""), [saveNotice, setSaveNotice] = createSignal("");
  const [query, setQuery] = createSignal(untrack(() => props.query.get("find") || "")), [results, setResults] = createSignal<SearchResults | null>(null), [searchBusy, setSearchBusy] = createSignal(false), [searchError, setSearchError] = createSignal("");
  const [clock, setClock] = createSignal("");
  const id = createUniqueId();
  let a!: HTMLIFrameElement, b!: HTMLIFrameElement, c!: HTMLIFrameElement, controller: ReaderFrames | undefined, writer: ProgressWriter | undefined, searchRequest: AbortController | undefined;
  let toc!: HTMLDialogElement, search!: HTMLDialogElement, preferences!: HTMLDialogElement, searchInput!: HTMLInputElement;
  let tocTrigger!: HTMLButtonElement, searchTrigger!: HTMLButtonElement, settingsTrigger!: HTMLButtonElement;
  let cleanup: (() => void) | undefined, disposed = false, firstPosition = true;
  const current = () => props.data.sections[position().section];
  const detailUrl = () => `/book/${book().book_id}${props.data.return_to === "/" ? "" : `?${new URLSearchParams({ return_to: props.data.return_to })}`}`;
  const url = (section: number, extra: Record<string, string> = {}) => sectionUrl(book().book_id, section, props.data.return_to, extra);
  const updateSetting = <K extends keyof ReaderSettings>(name: K, value: ReaderSettings[K]) => setSettings(old => normalizeSettings({ ...old, [name]: value }));
  const panelElement = (name: Panel) => ({ toc, search, settings: preferences })[name];
  const trigger = (name: Panel) => ({ toc: tocTrigger, search: searchTrigger, settings: settingsTrigger })[name];
  function closePanel(restoreFocus = true) {
    const previous = panel(); setPanel(null);
    if (previous && restoreFocus) trigger(previous).focus();
  }
  const togglePanel = (name: Panel) => panel() === name ? closePanel() : setPanel(name);
  function openSection(section: number, page = 1, find = "") {
    setChapterFocusPending(true); controller?.open(section, page, find); closePanel(false);
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
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (panel()) {
        if (event.key === "Escape") { event.preventDefault(); closePanel(); }
        else if (event.key === "Tab" && panel() === "toc") {
          const items = Array.from(toc.querySelectorAll<HTMLElement>("button, a[href]")), first = items[0], last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        return;
      }
      if ((event.target as Element | null)?.closest("input, textarea, select, button, a, [contenteditable]")) return;
      // ReaderFrames handles arrows, PageUp/PageDown and Space in both documents.
      if (event.key === "Backspace") {
        event.preventDefault(); controller?.turn(-1);
      } else controller?.key(event);
    };
    // Backspace is also a Python shortcut inside the sandboxed chapter document.
    const removeFrameKeys = [a, b, c].map(frame => {
      let chapter: Document | null = null;
      const backspace = (event: KeyboardEvent) => { if (event.key === "Backspace") key(event); };
      const loaded = () => {
        chapter?.removeEventListener("keydown", backspace);
        chapter = frame.contentDocument;
        chapter?.addEventListener("keydown", backspace);
      };
      frame.addEventListener("load", loaded); loaded();
      return () => { frame.removeEventListener("load", loaded); chapter?.removeEventListener("keydown", backspace); };
    });
    const outside = (event: PointerEvent) => {
      const active = panel(), target = event.target as Node | null;
      if (active && target && !panelElement(active).contains(target) && !trigger(active).contains(target)) closePanel(false);
    };
    const focus = (event: FocusEvent) => {
      const active = panel(), target = event.target as Node | null;
      if (active && active !== "toc" && target && !panelElement(active).contains(target) && !trigger(active).contains(target)) closePanel(false);
    };
    const hide = () => { if (document.visibilityState === "hidden") writer?.unload(navigator.sendBeacon.bind(navigator)); };
    const unload = () => writer?.unload(navigator.sendBeacon.bind(navigator));
    const pop = () => {
      const match = new RegExp(`^/book/${book().book_id}/preview/(\\d+)/?$`).exec(window.location.pathname);
      if (match) { closePanel(false); controller?.open(Number(match[1])); }
    };
    const time = () => setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));
    time(); const timer = setInterval(time, 29_000);
    window.addEventListener("keydown", key); window.addEventListener("pagehide", unload); window.addEventListener("popstate", pop);
    document.addEventListener("visibilitychange", hide); document.addEventListener("pointerdown", outside); document.addEventListener("focusin", focus);
    cleanup = () => {
      removeFrameKeys.forEach(remove => remove());
      clearInterval(timer); window.removeEventListener("keydown", key); window.removeEventListener("pagehide", unload); window.removeEventListener("popstate", pop);
      document.removeEventListener("visibilitychange", hide); document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", focus);
    };
  });
  createEffect(() => settings(), value => {
    if (!controller || disposed) return;
    controller.configure(value);
    try { localStorage.setItem("bindery:reader", JSON.stringify(value)); } catch { /* settings still work without storage */ }
  });
  createEffect(() => panel(), active => {
    if (!active) return;
    const animation = requestAnimationFrame(() => {
      if (panel() !== active) return;
      if (active === "toc") {
        const link = toc.querySelector<HTMLElement>("[aria-current=page]");
        link?.scrollIntoView({ block: "center" }); (link || toc.querySelector<HTMLElement>("button"))?.focus();
      } else if (active === "search") searchInput.focus();
      else preferences.querySelector<HTMLElement>("[aria-pressed=true]")?.focus();
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
  const previousDisabled = () => busy() || (position().section === 0 && position().page <= 1);
  const nextDisabled = () => busy() || (position().section === props.data.sections.length - 1 && position().page >= position().pageCount);
  return <article class="reader-page" data-background={settings().readerBg} data-brightness={settings().brightnessMode} data-panel-open={panel() || undefined} aria-label={`阅读 ${book().title}`}>
    <header class="reader-toolbar">
      <button ref={tocTrigger} class="reader-icon-button" type="button" aria-label="切换目录" aria-haspopup="dialog" aria-controls={`${id}-toc`} aria-expanded={panel() === "toc" ? "true" : "false"} onClick={() => togglePanel("toc")}><ReaderIcon name="menu" /></button>
      <Link class="reader-back" href={detailUrl()} aria-label="返回详情"><ReaderIcon name="previous" /><span>返回详情</span></Link>
      <div class="reader-heading" title={`${book().title} · ${current()?.title || ""}`}><span>{book().title} · {current()?.title}</span></div>
      <button ref={searchTrigger} class="reader-icon-button reader-search-toggle" type="button" aria-label="全文检索" title="全文检索" aria-haspopup="dialog" aria-controls={`${id}-search`} aria-expanded={panel() === "search" ? "true" : "false"} onClick={() => togglePanel("search")}><ReaderIcon name="search" /></button>
      <button ref={settingsTrigger} class="reader-icon-button" type="button" aria-label="设置" title="设置" aria-haspopup="dialog" aria-controls={`${id}-settings`} aria-expanded={panel() === "settings" ? "true" : "false"} onClick={() => togglePanel("settings")}><ReaderIcon name="settings" /></button>
    </header>
    <div class="reader-column" inert={panel() !== null}>
      <div class="reader-stage" aria-busy={busy() ? "true" : "false"}>
        <iframe ref={a} class={`reader-frame ${position().frame === 0 ? "is-active" : ""}`} title="阅读正文" sandbox="allow-same-origin" referrerpolicy="no-referrer" src={contentUrl(book().book_id, props.data.sections[initial.section].item_path)} aria-hidden={position().frame !== 0 ? "true" : "false"} tabindex={position().frame === 0 ? 0 : -1} />
        <iframe ref={b} class={`reader-frame ${position().frame === 1 ? "is-active" : ""}`} title="预载章节一" sandbox="allow-same-origin" referrerpolicy="no-referrer" aria-hidden={position().frame !== 1 ? "true" : "false"} tabindex={position().frame === 1 ? 0 : -1} />
        <iframe ref={c} class={`reader-frame ${position().frame === 2 ? "is-active" : ""}`} title="预载章节二" sandbox="allow-same-origin" referrerpolicy="no-referrer" aria-hidden={position().frame !== 2 ? "true" : "false"} tabindex={position().frame === 2 ? 0 : -1} />
        <Show when={busy()}><p class="reader-loading" role="status">章节切换中...</p></Show>
        <Show when={error()}><div class="reader-load-error" role="alert"><p>{error()}</p><Button variant="secondary" onClick={() => controller?.retry()}>重试</Button></div></Show>
        <noscript><p>启用 JavaScript 后可翻页和保存阅读进度。<a href={contentUrl(book().book_id, current().item_path)}>打开当前章节</a></p></noscript>
      </div>
      <footer class="reader-status">
        <span role="status" aria-live="polite">{position().page} / {position().pageCount} · {Math.round(position().page / position().pageCount * 100)}%</span>
        <time class="reader-clock">{clock()}</time>
      </footer>
    </div>
    <button class="reader-page-turn reader-page-previous" type="button" disabled={previousDisabled()} aria-label="上一页" title="上一页（← / PageUp / Backspace）" hidden={panel() !== null} onClick={() => controller?.turn(-1)}><ReaderIcon name="previous" /></button>
    <button class="reader-page-turn reader-page-next" type="button" disabled={nextDisabled()} aria-label="下一页" title="下一页（→ / PageDown / 空格）" hidden={panel() !== null} onClick={() => controller?.turn(1)}><ReaderIcon name="next" /></button>
    <Show when={saveNotice()}><p role="status" class="reader-save-notice">{saveNotice()}</p></Show>
    <div class="reader-panel-backdrop" data-drawer={panel() === "toc" ? "true" : "false"} hidden={panel() === null} aria-hidden="true" onPointerDown={event => event.stopPropagation()} onClick={() => closePanel()} />
    <dialog ref={toc} id={`${id}-toc`} open={panel() === "toc"} class="reader-panel reader-toc" aria-modal="true" aria-label="目录" onCancel={event => { event.preventDefault(); closePanel(); }}>
      <div class="reader-book"><div class="reader-cover"><BookCover {...book()} /></div><div class="reader-book-copy"><h2>{book().title}</h2><p>{book().author || "未知"}</p><p>共 {props.data.sections.length} 节 · 当前 {position().section + 1}</p></div><button class="reader-icon-button" type="button" aria-label="关闭目录" onClick={() => closePanel()}><ReaderIcon name="close" /></button></div>
      <nav aria-label="章节目录"><ol><For each={props.data.sections}>{(section, index) => <li><a href={url(index())} title={section.title} data-current-toc={index() === position().section ? "true" : undefined} aria-current={index() === position().section ? "page" : undefined} onClick={event => { if (controller && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openSection(index()); } }}>{section.title}</a></li>}</For></ol></nav>
    </dialog>
    <dialog ref={search} id={`${id}-search`} open={panel() === "search"} class="reader-panel reader-popover reader-search" aria-labelledby={`${id}-search-title`} onCancel={event => { event.preventDefault(); closePanel(); }}>
      <div class="reader-panel-heading"><h2 id={`${id}-search-title`}>全文检索</h2><button class="reader-icon-button" type="button" aria-label="关闭检索" onClick={() => closePanel()}><ReaderIcon name="close" /></button></div>
      <form class="reader-search-form" onSubmit={event => { event.preventDefault(); void runSearch(); }}>
        <input ref={searchInput} aria-label="关键词" type="search" maxlength={200} placeholder="输入关键词，回车检索" value={query()} onInput={event => setQuery(event.currentTarget.value)} />
        <button class="reader-search-submit" type="submit" disabled={searchBusy() || !query().trim()}>{searchBusy() ? "检索中..." : "检索"}</button>
        <button class="reader-control" type="button" onClick={clearSearch}>清空</button>
      </form>
      <Show when={results() && !searchBusy()}><p class="reader-search-summary" role="status">已加载：{results()!.hits.length} · 已索引章节：{results()!.indexed_sections}{results()!.has_more ? " · 可继续加载" : ""}</p></Show>
      <Show when={searchError()}><p role="alert" class="field-error">{searchError()}</p></Show>
      <div class="reader-search-content">
        <ol class="reader-search-results"><For each={results()?.hits || []}>{hit => <li><a href={hitHref(hit)} onClick={event => { if (controller && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openSection(hit.index, 1, results()?.query || query()); } }}><strong><HighlightedText text={hit.title} query={results()?.query || ""} /></strong><span><HighlightedText text={hit.snippet} query={results()?.query || ""} /></span></a></li>}</For></ol>
        <Show when={results() && !results()!.hits.length && !searchBusy()}><p class="reader-search-empty">未命中</p></Show>
        <Show when={results()?.has_more}><button class="reader-control reader-search-more" type="button" disabled={searchBusy()} onClick={() => void runSearch(true)}>加载更多</button></Show>
      </div>
    </dialog>
    <dialog ref={preferences} id={`${id}-settings`} open={panel() === "settings"} class="reader-panel reader-popover reader-settings" aria-labelledby={`${id}-settings-title`} onCancel={event => { event.preventDefault(); closePanel(); }}>
      <div class="reader-panel-heading"><h2 id={`${id}-settings-title`}>设置</h2><button class="reader-icon-button" type="button" aria-label="关闭设置" onClick={() => closePanel()}><ReaderIcon name="close" /></button></div>
      <fieldset class="reader-setting-group"><legend>背景</legend><div class="reader-backgrounds"><For each={backgrounds}>{choice => <button class="reader-control" type="button" aria-pressed={settings().readerBg === choice.value ? "true" : "false"} onClick={() => updateSetting("readerBg", choice.value)}>{choice.label}</button>}</For></div></fieldset>
      <div class="reader-segmented" role="group" aria-label="亮度"><button type="button" aria-pressed={settings().brightnessMode === "bright" ? "true" : "false"} onClick={() => updateSetting("brightnessMode", "bright")}>亮色</button><button type="button" aria-pressed={settings().brightnessMode === "dim" ? "true" : "false"} onClick={() => updateSetting("brightnessMode", "dim")}>暗色</button></div>
      <fieldset class="reader-setting-group"><legend>样式</legend><div class="reader-segmented"><button type="button" aria-pressed={settings().styleMode === "book" ? "true" : "false"} onClick={() => updateSetting("styleMode", "book")}>书籍</button><button type="button" aria-pressed={settings().styleMode === "custom" ? "true" : "false"} onClick={() => updateSetting("styleMode", "custom")}>自定义</button></div><p class="reader-style-hint">书籍：尽量保持 EPUB 原样式；自定义：覆盖字体/字号/行高。</p></fieldset>
      <Show when={settings().styleMode === "custom"}><div class="reader-custom-settings">
        <label class="reader-setting"><span>字体</span><select value={settings().fontFamily} onChange={event => updateSetting("fontFamily", event.currentTarget.value as ReaderSettings["fontFamily"])}><option value="serif">衬线</option><option value="sans">无衬线</option><option value="mono">等宽</option></select></label>
        <ReaderStepper label="字号" value={settings().fontSize} min={11} max={27} step={1} decrease="A-" increase="A+" onChange={value => updateSetting("fontSize", value)} />
        <label class="reader-setting"><span>行高</span><select value={settings().lineHeight} onChange={event => updateSetting("lineHeight", Number(event.currentTarget.value))}><For each={lineHeights}>{value => <option value={value}>{value}</option>}</For></select></label>
        <label class="reader-setting"><span>对齐</span><select value={settings().textAlignMode} onChange={event => updateSetting("textAlignMode", event.currentTarget.value as ReaderSettings["textAlignMode"])}><option value="justify">两端对齐</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
        <ReaderStepper label="左右边距" value={settings().pagePaddingX} min={-1} max={47} step={2} onChange={value => updateSetting("pagePaddingX", value)} />
        <ReaderStepper label="上下边距" value={settings().pagePaddingY} min={-1} max={47} step={2} onChange={value => updateSetting("pagePaddingY", value)} />
      </div></Show>
    </dialog>
  </article>;
}

function ReaderStepper(props: { label: string; value: number; min: number; max: number; step: number; decrease?: string; increase?: string; onChange: (value: number) => void }) {
  return <div class="reader-setting" role="group" aria-label={props.label}><span>{props.label}</span><div class="reader-stepper">
    <button class="reader-control" type="button" aria-label={`减小${props.label}`} disabled={props.value <= props.min} onClick={() => props.onChange(Math.max(props.min, props.value - props.step))}>{props.decrease || "-"}</button>
    <output aria-label={props.label}>{props.value}px</output>
    <button class="reader-control" type="button" aria-label={`增大${props.label}`} disabled={props.value >= props.max} onClick={() => props.onChange(Math.min(props.max, props.value + props.step))}>{props.increase || "+"}</button>
  </div></div>;
}
function HighlightedText(props: { text: string; query: string }) {
  return <For each={highlightedParts(props.text, props.query)}>{part => <Show when={part.matched} fallback={part.text}><mark>{part.text}</mark></Show>}</For>;
}
function ReaderIcon(props: { name: "menu" | "previous" | "next" | "search" | "settings" | "close" }) {
  const paths = { menu: "M3 6h16M3 12h16M3 18h16", previous: "m14 18-5-6 6-6", next: "m8 18 6-6-6-6", search: "m20 20-4.2-4.2", close: "m5 6 12 12M17 6 6 18", settings: "M18.2 12a7.5 7.5 0 0 0-.08-1l2.02-1.57-2-3.46-2.43.98a7.35 7.35 0 0 0-1.74-1l-.37-2.58H9.4l-.37 2.58a7.35 7.35 0 0 0-1.74 1l-2.43-.98-2 3.46L4.88 11a7.5 7.5 0 0 0 0 2l-2.02 1.57 2 3.46 2.43-.98a7.35 7.35 0 0 0 1.74 1l.37 2.58h5.2l.37-2.58a7.35 7.35 0 0 0 1.74-1l2.43.98 2-3.46L19.12 13c.05-.33.08-.66.08-1Z" };
  return <svg viewBox="-1 0 24 24" fill="none" stroke="currentColor" stroke-width={props.name === "settings" ? 1 : 2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={paths[props.name]} />
    <Show when={props.name === "search"}><circle cx="10.5" cy="10.5" r="5.5" /></Show>
    <Show when={props.name === "settings"}><circle cx="11" cy="12" r="3.25" /></Show>
  </svg>;
}
