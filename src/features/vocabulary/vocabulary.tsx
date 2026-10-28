import TablerCheck from "~icons/tabler/check";
import TablerSettings from "~icons/tabler/settings";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { Button, EmptyState, Icon, PageIntro, SearchPill, SegmentedControl, SelectPill, SideSheet, StatusDot, TextField, ToggleSwitch, Toolbar } from "../../ui";
import type { PushState, VocabularyChoice, VocabularyItem, VocabularyPage } from "../../server/vocabulary/query";
import type { ConnectionTest, LexiTraceSettingsView } from "../../server/vocabulary/settings";
import { BookTitle, HighlightedSentence, vocabularyMonthQuery, WordSource } from "./display";
import "./vocabulary.css";

export interface VocabularySettingsInput { baseUrl?: string; token?: string; clearToken?: boolean; enabled?: boolean }
export interface VocabularyApi {
  list: (input: { month_start?: string }) => Promise<VocabularyPage>;
  retry: (ids?: string[]) => Promise<{ retried: number; page: VocabularyPage }>;
  saveSettings: (input: VocabularySettingsInput) => Promise<LexiTraceSettingsView>;
  testConnection: (input: VocabularySettingsInput) => Promise<ConnectionTest>;
}
export interface VocabularyFilters { deviceId: string; bookId: string; pushState: PushState | "all" | "failed"; query: string }
const STATUS: Record<PushState, string> = { pending: "未推送", pushed: "已推送", conflict: "冲突", error: "失败" };
export const pushStatusLabel = (item: Pick<VocabularyItem, "push_state">) => STATUS[item.push_state] ?? "未推送";
const failed = (item: VocabularyItem) => item.push_state === "error" || item.push_state === "conflict";
export function filterVocabularyItems(items: readonly VocabularyItem[], filters: VocabularyFilters): VocabularyItem[] {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    const text = `${item.word} ${item.raw_word} ${item.book_title} ${item.device_name} ${item.context.sentence}`.toLocaleLowerCase();
    return (filters.deviceId === "all" || item.device_id === filters.deviceId) &&
      (filters.bookId === "all" || item.book_key === filters.bookId) &&
      (filters.pushState === "all" || (filters.pushState === "failed" ? failed(item) : item.push_state === filters.pushState)) &&
      terms.every(term => text.includes(term));
  });
}
function choices(items: readonly VocabularyChoice[]) {
  return [{ value: "all", label: "全部" }, ...items.map(item => ({ value: item.key, label: `${item.label}（${item.count}）` }))];
}
function testMessage(result: ConnectionTest): string {
  if (result.ok) return `连接成功 · ${result.latencyMs} 毫秒`;
  const category = result.category ?? "http_error";
  if (category === "auth") return `认证失败（HTTP ${result.status ?? 401}）：请检查令牌`;
  if (category === "disabled") return `LexiTrace 集成未启用或暂不可用（HTTP ${result.status ?? 503}）`;
  if (category === "network") return "无法连接：网络错误或请求超时";
  if (category === "not_configured") return "请先填写 LexiTrace 地址和令牌";
  return `连接失败（HTTP ${result.status ?? "未知"}）`;
}

export function VocabularyPage(props: { initial: VocabularyPage; initialSettings: LexiTraceSettingsView; settingsOpen?: boolean; api: VocabularyApi }) {
  const [page, setPage] = createSignal(props.initial), [settings, setSettings] = createSignal(props.initialSettings);
  const [device, setDevice] = createSignal("all"), [book, setBook] = createSignal("all"), [status, setStatus] = createSignal<VocabularyFilters["pushState"]>("all"), [query, setQuery] = createSignal("");
  const [notice, setNotice] = createSignal(""), [error, setError] = createSignal(""), [busy, setBusy] = createSignal(false);
  const [baseUrl, setBaseUrl] = createSignal(props.initialSettings.baseUrl), [token, setToken] = createSignal("");
  const [enabled, setEnabled] = createSignal(props.initialSettings.enabled), [clearToken, setClearToken] = createSignal(false);
  const [saving, setSaving] = createSignal(false), [testing, setTesting] = createSignal(false);
  const [testResult, setTestResult] = createSignal<{ text: string; ok: boolean } | null>(null);
  const [settingsError, setSettingsError] = createSignal(""), [settingsNotice, setSettingsNotice] = createSignal("");
  const [settingsOpen, setSettingsOpen] = createSignal(Boolean(props.settingsOpen));
  createEffect(() => props.settingsOpen, open => { setSettingsOpen(Boolean(open)); });
  const visible = createMemo(() => filterVocabularyItems(page().items, { deviceId: device(), bookId: book(), pushState: status(), query: query() }));
  const hasFilters = () => device() !== "all" || book() !== "all" || status() !== "all" || Boolean(query());
  const resetFilters = () => { setDevice("all"); setBook("all"); setStatus("all"); setQuery(""); };
  // The SSR loader cannot know the reader's timezone; correct its summary after hydration.
  onSettled(() => { void refresh(); });
  async function refresh() {
    setBusy(true); setError("");
    try { setPage(await props.api.list(vocabularyMonthQuery())); }
    catch (e) { setError(e instanceof Error ? e.message : "加载生词失败"); }
    finally { setBusy(false); }
  }
  async function retry(ids?: string[]) {
    if (busy()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await props.api.retry(ids);
      setPage({ ...result.page, summary: { ...result.page.summary, month: page().summary.month } });
      setNotice(`已重新排队 ${result.retried} 个生词`);
      // Retry's existing endpoint returns a server-local summary. Re-read with the browser month.
      setPage(await props.api.list(vocabularyMonthQuery()));
    } catch (e) { setError(e instanceof Error ? e.message : "重试推送失败"); }
    finally { setBusy(false); }
  }
  function closeSettings() {
    if (saving() || testing()) return;
    setSettingsOpen(false); setToken(""); setClearToken(false); setBaseUrl(settings().baseUrl); setEnabled(settings().enabled);
    setSettingsError(""); setSettingsNotice(""); setTestResult(null);
  }
  async function save() {
    if (saving() || testing()) return;
    setSaving(true); setSettingsError(""); setTestResult(null); setSettingsNotice("");
    try {
      const saved = await props.api.saveSettings({ baseUrl: baseUrl(), token: token(), clearToken: clearToken(), enabled: enabled() });
      setSettings(saved); setBaseUrl(saved.baseUrl); setToken(""); setClearToken(false); setEnabled(saved.enabled);
      setSettingsNotice("LexiTrace 设置已保存");
    } catch (e) { setSettingsError(e instanceof Error ? e.message : "保存 LexiTrace 设置失败"); }
    finally { setSaving(false); }
  }
  async function test() {
    if (testing() || saving()) return;
    setTesting(true); setSettingsError(""); setTestResult(null);
    try { const result = await props.api.testConnection({ baseUrl: baseUrl(), token: token() }); setTestResult({ text: testMessage(result), ok: result.ok }); }
    catch (e) { setTestResult({ text: e instanceof Error ? e.message : "测试连接失败", ok: false }); }
    finally { setTesting(false); }
  }
  return <section aria-label="生词本" class="vocab-page">
    <PageIntro class="vocab-intro" visualSize="vocabulary" controlsPlacement="aside" eyebrow={<><span class="vocab-eyebrow-wide">生词本 · 从 Kindle 和 Kobo 同步 · 共 {page().summary.total} 个</span><span class="vocab-eyebrow-phone">生词本 · 共 {page().summary.total} 个</span></>}
      title={page().summary.month.count ? `这个月查了 ${page().summary.month.count} 个词。` : `已经记下 ${page().summary.total} 个词。`}
      description={<Show when={page().summary.month.top_source} fallback="把读到的生词，连同当时的句子留下来。">{source => <>
        多半来自<BookTitle title={source().title} />。<Show when={page().summary.latest}><span class="vocab-description-wide">右边是最近查的一个，连同查词时读到的那句话。</span><span class="vocab-description-phone">下面是最近查的一个，连同当时读到的那句话。</span></Show>
      </>}</Show>}
      status={<>
        <p class="vocab-push-line"><span><StatusDot tone="ok" label="已推送" />LexiTrace 已推送 {page().summary.push.pushed} 个</span><Show when={page().summary.push.failed}><span class="vocab-failure"><StatusDot tone="danger" label="推送失败" />{page().summary.push.failed} 个失败</span></Show></p>
      </>}
      note={<>
        <Show when={!settings().baseUrl || !settings().hasToken}><p class="vocab-hint">尚未配置 LexiTrace，生词会照常保存在这里。</p></Show>
        <Show when={settings().baseUrl && settings().hasToken && !settings().enabled}><p class="vocab-hint">LexiTrace 推送已暂停，生词仍会同步。</p></Show>
      </>}
      actions={<div class="vocab-action-row"><Show when={page().summary.push.failed}><Button variant="secondary" disabled={busy()} onClick={() => retry()}>{busy() ? "处理中…" : "全部重试"}</Button></Show>
        <Button variant="icon" class="vocab-settings-button" aria-label="LexiTrace 设置" title="LexiTrace 设置" aria-haspopup="dialog" aria-expanded={settingsOpen() ? "true" : "false"} aria-controls="lexitrace-settings" onClick={() => setSettingsOpen(true)}>
          <Icon icon={TablerSettings} size={20} class="vocab-settings-glyph" /><span class="vocab-settings-text">设置</span>
        </Button>
      </div>}
      visual={page().summary.latest ? <Show when={page().summary.latest}>{latest => <figure class="vocab-latest" aria-label="最近查的">
        <p class="vocab-section-label">最近查的</p><p class="vocab-latest-word">{latest().word}</p>
        <Show when={latest().context.sentence} fallback={<p class="vocab-hint">未找到例句</p>}><blockquote><HighlightedSentence sentence={latest().context.sentence} raw={latest().raw_word} word={latest().word} /></blockquote></Show>
        <figcaption><WordSource item={latest()} /></figcaption>
      </figure>}</Show> : undefined} />
    <Show when={notice()}><p class="vocab-message" role="status">{notice()}</p></Show>
    <Show when={error()}><div class="vocab-failure" role="alert">{error()} <Button variant="secondary" disabled={busy()} onClick={refresh}>重新加载</Button></div></Show>
    <Toolbar label="筛选生词" search={<SearchPill label="搜索生词、例句、书籍或设备" placeholder="搜索生词、例句" value={query()} onInput={event => setQuery(event.currentTarget.value)} />}>
      <SelectPill label="书" value={book()} options={choices(page().books)} onChange={setBook} />
      <SelectPill label="设备" value={device()} options={choices(page().devices)} onChange={setDevice} />
      <SegmentedControl label="推送状态" value={status() === "error" || status() === "conflict" ? "failed" : status()} options={[{ value: "all", label: "全部" }, { value: "pending", label: "未推送" }, { value: "failed", label: "失败" }]} onChange={value => setStatus(value as VocabularyFilters["pushState"])} />
    </Toolbar>
    <ul class="vocab-directory" aria-label="生词列表" aria-busy={busy() ? "true" : "false"}><For each={visible()}>{item => <li>
      <div class="vocab-word-heading"><h2>{item.word}</h2><Show when={item.raw_word !== item.word}><span class="vocab-raw">{item.raw_word}</span></Show><Show when={item.push_state !== "pushed"}><StatusDot label={failed(item) ? `${pushStatusLabel(item)}，可在详情中重试` : "未推送到 LexiTrace"} tone={failed(item) ? "danger" : "empty"} /></Show></div>
      <p class="vocab-sentence"><Show when={item.context.sentence} fallback={<span class="vocab-hint">未找到例句</span>}><HighlightedSentence sentence={item.context.sentence} raw={item.raw_word} word={item.word} /></Show></p>
      <p class="vocab-source-line"><WordSource item={item} /></p>
      <details class="vocab-word-details"><summary aria-label={`${item.word} 的详情`}>详情</summary>
        <Show when={item.context.sentence}><p class="vocab-full-sentence"><HighlightedSentence sentence={item.context.sentence} raw={item.raw_word} word={item.word} /></p></Show>
        <Show when={item.context.previous.length}><p>前文：{item.context.previous.join(" ")}</p></Show>
        <Show when={item.context.following.length}><p>后文：{item.context.following.join(" ")}</p></Show>
        <p>推送状态：{pushStatusLabel(item)}</p>
        <Show when={failed(item)}><p><Show when={item.push_status?.http}>HTTP {item.push_status?.http}</Show><Show when={item.push_status?.attempts}> · 尝试 {item.push_status?.attempts} 次</Show><Show when={item.push_status?.retryable === false}> · 需手动重试</Show></p><Button variant="secondary" disabled={busy()} aria-label={`重试推送 ${item.word}`} onClick={() => retry([item.id])}>重试</Button></Show>
      </details>
    </li>}</For></ul>
    <Show when={!visible().length}><EmptyState title={page().summary.total ? "没有符合条件的生词" : "生词本还是空的"}>{page().summary.total ? "试试清除筛选或搜索其他内容。" : "在电脑上连接 Kindle 或 Kobo 后，查过的生词会自动同步。"}<Show when={hasFilters()}><Button variant="quiet" onClick={resetFilters}>清除筛选</Button></Show></EmptyState></Show>
    <p class="sr-only" role="status">显示 {visible().length} / {page().summary.total} 个</p>
    <SideSheet id="lexitrace-settings" class="vocab-settings" open={settingsOpen()} title="LexiTrace" subtitle="从设备同步来的生词会自动推送到 LexiTrace。令牌只存在服务器上，不会再发回浏览器。" onClose={closeSettings} actions={<>
      <Show when={settings().hasToken}><Button variant="quiet-danger" disabled={saving() || testing()} aria-pressed={clearToken() ? "true" : "false"} onClick={() => setClearToken(!clearToken())}>{clearToken() ? "撤销清除" : "清除令牌"}</Button></Show>
      <Button variant="quiet" size="lg" disabled={saving() || testing()} onClick={closeSettings}>取消</Button><Button size="lg" type="submit" form="vocab-settings-form" disabled={saving() || testing()}>{saving() ? "保存中…" : "保存"}</Button>
    </>}>
      <form id="vocab-settings-form" class="vocab-settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <div class="vocab-toggle-row"><div><p>推送生词</p><p id="vocab-push-hint" class="vocab-hint">关掉后照常同步，只是不再推送。</p></div><ToggleSwitch label="推送生词" checked={enabled()} onChange={setEnabled} disabled={saving() || testing()} describedBy="vocab-push-hint" /></div>
        <TextField label="地址" name="baseUrl" type="url" placeholder="https://lexitrace.example" value={baseUrl()} disabled={saving() || testing()} onInput={event => setBaseUrl(event.currentTarget.value)} hint="HTTPS，或本机的 HTTP 回环地址" />
        <div class="vocab-token-field">
          <TextField label="访问令牌" name="token" type="password" autocomplete="new-password" placeholder={settings().hasToken ? "已保存，留空则保持不变" : "输入 LexiTrace 令牌"} value={token()} disabled={saving() || testing()} onInput={event => setToken(event.currentTarget.value)} hint={settings().hasToken ? undefined : "令牌只保存在服务器，不会返回浏览器。"} />
          <Show when={settings().hasToken}><span class="vocab-token-saved"><Icon icon={TablerCheck} size={14} />已保存</span></Show>
        </div>
        <Show when={clearToken()}><p class="vocab-failure" role="status">保存后将清除已保存的令牌；取消不会更改设置。</p></Show>
        <div class="vocab-test-row"><Button variant="secondary" disabled={testing() || saving()} onClick={test}>{testing() ? "测试中…" : "测试连接"}</Button><Show when={testResult()}>{result => <p role="status" class={result().ok ? "vocab-test-result is-ok" : "vocab-test-result is-failure"}><StatusDot tone={result().ok ? "ok" : "danger"} label={result().ok ? "连接成功" : "连接失败"} />{result().text}</p>}</Show></div>
        <Show when={settingsNotice()}><p role="status">{settingsNotice()}</p></Show><Show when={settingsError()}><p class="vocab-failure" role="alert">{settingsError()}</p></Show>
      </form>
    </SideSheet>
  </section>;
}
