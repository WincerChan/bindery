import { createMemo, createSignal, For, Show } from "solid-js";
import { Button, Checkbox, EmptyState, LocalTime, Select, Tag, TextField } from "../../ui";
import type { PushState, VocabularyChoice, VocabularyItem, VocabularyPage } from "../../server/vocabulary/query";
import type { ConnectionTest, LexiTraceSettingsView } from "../../server/vocabulary/settings";

export interface VocabularySettingsInput { baseUrl?: string; token?: string; clearToken?: boolean; enabled?: boolean }
export interface VocabularyApi {
  list: () => Promise<VocabularyPage>;
  retry: (ids?: string[]) => Promise<{ retried: number; page: VocabularyPage }>;
  saveSettings: (input: VocabularySettingsInput) => Promise<LexiTraceSettingsView>;
  testConnection: (input: VocabularySettingsInput) => Promise<ConnectionTest>;
}
export interface VocabularyFilters { deviceId: string; bookId: string; pushState: PushState | "all"; query: string }

const STATUS: Record<PushState, { label: string; tone: "neutral" | "ok" | "pending" | "failed" }> = {
  pending: { label: "未推送", tone: "pending" },
  pushed: { label: "已推送", tone: "ok" },
  conflict: { label: "冲突", tone: "failed" },
  error: { label: "失败", tone: "failed" },
};
export const pushStatusLabel = (item: Pick<VocabularyItem, "push_state">) => STATUS[item.push_state]?.label ?? "未推送";
export function filterVocabularyItems(items: readonly VocabularyItem[], filters: VocabularyFilters): VocabularyItem[] {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    const text = `${item.word} ${item.book_title} ${item.device_name} ${item.context.sentence}`.toLocaleLowerCase();
    return (filters.deviceId === "all" || item.device_id === filters.deviceId) &&
      (filters.bookId === "all" || item.book_key === filters.bookId) &&
      (filters.pushState === "all" || item.push_state === filters.pushState) &&
      terms.every(term => text.includes(term));
  });
}
function choices(items: readonly VocabularyItem[], key: (item: VocabularyItem) => string, label: (item: VocabularyItem) => string): VocabularyChoice[] {
  const choices = new Map<string, VocabularyChoice>();
  for (const item of items) {
    const current = choices.get(key(item));
    if (current) current.count++;
    else choices.set(key(item), { key: key(item), label: label(item), count: 1 });
  }
  return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}
function testMessage(result: ConnectionTest): string {
  if (result.ok) return `连接成功（HTTP ${result.status ?? 200}，${result.latencyMs} 毫秒）`;
  const category = result.category ?? "http_error";
  if (category === "auth") return `认证失败（HTTP ${result.status ?? 401}）：请检查令牌`;
  if (category === "disabled") return `LexiTrace 集成未启用或暂不可用（HTTP ${result.status ?? 503}）`;
  if (category === "network") return "无法连接：网络错误或请求超时";
  if (category === "not_configured") return "请先填写 LexiTrace 地址和令牌";
  return `连接失败（HTTP ${result.status ?? "未知"}）`;
}

export function VocabularyPage(props: { initial: VocabularyPage; initialSettings: LexiTraceSettingsView; settingsOpen?: boolean; api: VocabularyApi }) {
  const [page, setPage] = createSignal(props.initial), [settings, setSettings] = createSignal(props.initialSettings);
  const [device, setDevice] = createSignal("all"), [book, setBook] = createSignal("all"), [status, setStatus] = createSignal<PushState | "all">("all"), [query, setQuery] = createSignal("");
  const [notice, setNotice] = createSignal(""), [error, setError] = createSignal(""), [busy, setBusy] = createSignal(false);
  const [baseUrl, setBaseUrl] = createSignal(props.initialSettings.baseUrl), [token, setToken] = createSignal("");
  const [enabled, setEnabled] = createSignal(props.initialSettings.enabled), [clearToken, setClearToken] = createSignal(false);
  const [saving, setSaving] = createSignal(false), [testing, setTesting] = createSignal(false), [testResult, setTestResult] = createSignal("");
  const devices = createMemo(() => choices(page().items, item => item.device_id, item => item.device_name));
  const books = createMemo(() => choices(page().items, item => item.book_key, item => item.book_title));
  const visible = createMemo(() => filterVocabularyItems(page().items, { deviceId: device(), bookId: book(), pushState: status(), query: query() }));
  const retryable = createMemo(() => page().items.some(item => item.push_state === "error" || item.push_state === "conflict"));
  const filters: VocabularyFilters = { deviceId: "all", bookId: "all", pushState: "all", query: "" };
  const resetFilters = () => { setDevice(filters.deviceId); setBook(filters.bookId); setStatus(filters.pushState); setQuery(filters.query); };
  async function refresh() {
    setBusy(true); setError("");
    try { setPage(await props.api.list()); }
    catch (e) { setError(e instanceof Error ? e.message : "加载生词失败"); }
    finally { setBusy(false); }
  }
  async function retry(ids?: string[]) {
    setBusy(true); setError("");
    try {
      const result = await props.api.retry(ids);
      setPage(result.page);
      setNotice(`已重新排队 ${result.retried} 个生词`);
    } catch (e) { setError(e instanceof Error ? e.message : "重试推送失败"); }
    finally { setBusy(false); }
  }
  async function save() {
    setSaving(true); setError(""); setTestResult("");
    try {
      const saved = await props.api.saveSettings({ baseUrl: baseUrl(), token: token(), clearToken: clearToken(), enabled: enabled() });
      setSettings(saved); setBaseUrl(saved.baseUrl); setToken(""); setClearToken(false); setEnabled(saved.enabled);
      setNotice("LexiTrace 设置已保存");
    } catch (e) { setError(e instanceof Error ? e.message : "保存 LexiTrace 设置失败"); }
    finally { setSaving(false); }
  }
  async function test() {
    setTesting(true); setError(""); setTestResult("");
    try { setTestResult(testMessage(await props.api.testConnection({ baseUrl: baseUrl(), token: token() }))); }
    catch (e) { setTestResult(e instanceof Error ? e.message : "测试连接失败"); }
    finally { setTesting(false); }
  }
  return <section aria-label="生词本" class="kindle-books vocabulary-page">
    <div class="kindle-section-heading"><span class="kindle-count kindle-mono">{page().totals.all} 个生词</span></div>
    <p class="kindle-small">生词会随设备连接自动同步；所有生词都会推送到 LexiTrace，未连接设备时也可查看。</p>
    <details id="lexitrace-settings" class="vocabulary-settings" open={props.settingsOpen || !settings().hasToken}>
      <summary>LexiTrace 设置</summary>
      <div class="vocabulary-settings-fields">
        <TextField label="LexiTrace 地址" type="url" placeholder="https://lexitrace.example" value={baseUrl()} onInput={event => setBaseUrl(event.currentTarget.value)} hint="HTTPS，或本机 HTTP 回环地址" />
        <TextField label="访问令牌" type="password" autocomplete="new-password" placeholder={settings().hasToken ? "已保存，留空保持不变" : "输入 LexiTrace 令牌"} value={token()} onInput={event => setToken(event.currentTarget.value)} hint={settings().hasToken ? "令牌只保存在服务器，不会返回浏览器" : "令牌只保存在服务器，不会返回浏览器"} />
        <div class="vocabulary-settings-actions">
          <Checkbox label="启用推送" checked={enabled()} onChange={event => setEnabled(event.currentTarget.checked)} />
          <Show when={settings().hasToken}><Checkbox label="清除已保存的令牌" checked={clearToken()} onChange={event => setClearToken(event.currentTarget.checked)} /></Show>
          <Button disabled={saving()} onClick={save}>{saving() ? "保存中…" : "保存设置"}</Button>
          <Button variant="secondary" disabled={testing() || saving()} onClick={test}>{testing() ? "测试中…" : "测试连接"}</Button>
        </div>
        <Show when={testResult()}><p class="kindle-small" role="status">{testResult()}</p></Show>
        <Show when={settings().hasToken}><p class="kindle-small">已保存令牌；服务器不会把它发送到浏览器。</p></Show>
      </div>
    </details>
    <Show when={notice()}><p class="notice" role="status">{notice()}</p></Show>
    <Show when={error()}><p class="field-error" role="alert">{error()}</p></Show>
    <div class="kindle-toolbar vocabulary-toolbar">
      <div class="kindle-filters" role="group" aria-label="筛选生词">
        <Select label="设备" value={device()} onChange={event => setDevice(event.currentTarget.value)}>
          <option value="all">全部设备（{devices().reduce((sum, item) => sum + item.count, 0)}）</option>
          <For each={devices()}>{item => <option value={item.key}>{item.label}（{item.count}）</option>}</For>
        </Select>
        <Select label="书籍" value={book()} onChange={event => setBook(event.currentTarget.value)}>
          <option value="all">全部书籍（{books().reduce((sum, item) => sum + item.count, 0)}）</option>
          <For each={books()}>{item => <option value={item.key}>{item.label}（{item.count}）</option>}</For>
        </Select>
        <Select label="推送状态" value={status()} onChange={event => setStatus(event.currentTarget.value as PushState | "all")}>
          <option value="all">全部状态</option><option value="pending">未推送</option><option value="pushed">已推送</option><option value="conflict">冲突</option><option value="error">失败</option>
        </Select>
      </div>
      <div class="kindle-toolbar-actions">
        <TextField class="kindle-search search-field" label="搜索生词" labelHidden type="search" placeholder="搜索生词、书籍或设备" value={query()} onInput={event => setQuery(event.currentTarget.value)} />
        <Button variant="quiet" disabled={busy()} onClick={resetFilters}>清除筛选</Button>
        <Button variant="secondary" disabled={busy() || !retryable()} onClick={() => retry()}>{busy() ? "处理中…" : "重试全部失败"}</Button>
      </div>
    </div>
    <div class="kindle-table-scroll" tabindex={0} role="region" aria-label="生词列表，可横向滚动"><table class="kindle-book-table vocabulary-table"><thead><tr>
      <th scope="col">生词</th><th scope="col">书籍</th><th scope="col">设备</th><th scope="col">查询时间</th><th scope="col">例句</th><th scope="col">推送状态</th><th scope="col">操作</th>
    </tr></thead><tbody><For each={visible()}>{item => <tr data-vocabulary-word={item.id}>
      <td><strong>{item.word}</strong><Show when={item.raw_word !== item.word}><p class="kindle-small">原文：{item.raw_word}</p></Show></td>
      <td>{item.book_title}</td>
      <td>{item.device_name}<p class="kindle-small">{item.device_kind === "kindle" ? "Kindle" : "Kobo"}</p></td>
      <td class="kindle-time"><LocalTime value={item.looked_up_at} /></td>
      <td class="vocabulary-context"><Show when={item.context.sentence} fallback={<span class="muted">未找到例句</span>}>
        <details><summary>{item.context.sentence.length > 80 ? `${item.context.sentence.slice(0, 80)}…` : item.context.sentence}</summary>
          <p>{item.context.sentence}</p>
          <Show when={item.context.previous.length}><p class="kindle-small">前文：{item.context.previous.join(" ")}</p></Show>
          <Show when={item.context.following.length}><p class="kindle-small">后文：{item.context.following.join(" ")}</p></Show>
        </details>
      </Show></td>
      <td><Tag tone={STATUS[item.push_state].tone}>{STATUS[item.push_state].label}</Tag>
        <Show when={item.push_state === "error" || item.push_state === "conflict"}><p class="kindle-small"><Show when={item.push_status?.http}>HTTP {item.push_status?.http}{item.push_status?.attempts ? ` · 尝试 ${item.push_status.attempts} 次` : ""}</Show><Show when={item.push_status?.retryable === false}> · 需手动重试</Show></p></Show>
      </td>
      <td><Button variant="quiet" size="sm" disabled={busy() || item.push_state === "pushed" || item.push_state === "pending"} onClick={() => retry([item.id])}>重试</Button></td>
    </tr>}</For></tbody></table></div>
    <Show when={!visible().length}><EmptyState title={page().totals.all ? "没有符合条件的生词" : "生词本还是空的"}>{page().totals.all ? "试试清除筛选或搜索其他内容。" : "连接 Kobo 或 Kindle 并授权后，生词会随阅读进度自动同步。"}</EmptyState></Show>
    <p class="kindle-table-note">显示 <span class="kindle-mono">{visible().length} / {page().totals.all}</span> 个 · 未推送 {page().totals.pending} · 已推送 {page().totals.pushed} · 冲突 {page().totals.conflict} · 失败 {page().totals.error}</p>
  </section>;
}
