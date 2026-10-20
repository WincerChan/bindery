import { createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Button, Select, Textarea, TextField } from "../../ui";
import { useMutation } from "../../shared/client-mutation";
import { flashFromUrl } from "../../shared/notifications";
import { showToast } from "../../client/toast";
import { formatCss } from "./css-format";
import { UploadPreviews } from "./preview";
import { RecentJobs } from "./jobs";
import type { JobsPayload, ingestOptions } from "../../server/ingest/queries";
import type { Preview } from "../../server/ingest/preview";

export function IngestPage(props: { options: ReturnType<typeof ingestOptions>; error?: string; custom_css?: string; jobs?: JobsPayload; jobsOpen?: boolean; openJobs?: () => unknown; closeJobs?: () => unknown }) {
  const mutation = useMutation();
  const [files, setFiles] = createSignal<File[]>([]), [previews, setPreviews] = createSignal<Preview[]>([]);
  const [busy, setBusy] = createSignal(false), [submitting, setSubmitting] = createSignal(false), [dragging, setDragging] = createSignal(false);
  const [error, setError] = createSignal(untrack(() => props.error || "")), [parseFailed, setParseFailed] = createSignal(false), [fileError, setFileError] = createSignal("");
  const [title, setTitle] = createSignal(""), [author, setAuthor] = createSignal(""), [theme, setTheme] = createSignal("default"), [css, setCss] = createSignal(untrack(() => props.custom_css || ""));
  // Jobs loader refreshes must not replace build settings or the selected files.
  const options = untrack(() => props.options);
  const valid = () => previews().filter(item => !item.error && item.upload_token);
  const duplicates = () => valid().filter(item => item.duplicates.length).length;
  const disabled = () => !valid().length || busy() || submitting() || parseFailed();
  const status = () => submitting() ? "正在提交…" : busy() ? "正在解析…" : !files().length ? "先选择文件" : parseFailed() ? "解析失败，请重新解析" : duplicates() ? `${duplicates()} 本疑似重复：不勾选「仍然新建」将归入已有书籍` : valid().length ? `已就绪 · ${valid().length} 本可入库` : "没有可入库的文件，请移除错误项或重新选择";
  let form!: HTMLFormElement, input!: HTMLInputElement, controller: AbortController | undefined;
  onCleanup(() => controller?.abort());
  function clear() {
    controller?.abort(); controller = undefined; setFiles([]); setPreviews([]); setBusy(false); setParseFailed(false); setError(""); setFileError(""); setTitle(""); setAuthor(""); input.value = "";
  }
  async function preview(batch = files()) {
    controller?.abort();
    if (!batch.length) { clear(); return; }
    const current = new AbortController(); controller = current;
    setBusy(true); setError(""); setParseFailed(false); setPreviews([]);
    try {
      const data = new FormData(form); data.delete("files"); data.delete("upload_tokens"); data.delete("dedupe_keep_tokens");
      for (const file of batch) data.append("files", file);
      const response = await fetch("/ingest/preview", { method: "POST", body: data, headers: { Accept: "application/json" }, signal: current.signal });
      if (response.redirected && new URL(response.url).pathname === "/login") { await mutation.router.navigate({ href: response.url }); return; }
      if (!response.ok) throw new Error(response.status === 413 ? "预览请求过大（413）：请减少单次文件数，或先压缩/拆分后再预览。" : `预览解析失败（HTTP ${response.status}），请稍后重试。`);
      const items: Preview[] = await response.json();
      if (current.signal.aborted || controller !== current) return;
      setPreviews(items);
      if (items.length === 1 && items[0]?.format === "TXT") { setTitle(items[0].title || ""); setAuthor(items[0].author || ""); }
    } catch (e) { if (!current.signal.aborted) { setParseFailed(true); setError(e instanceof Error ? e.message : "预览解析失败，请稍后重试。"); } }
    finally { if (controller === current) { controller = undefined; setBusy(false); } }
  }
  function add(incoming: File[]) {
    if (submitting()) return;
    const rejected = incoming.filter(file => !/\.(txt|epub)$/i.test(file.name));
    setFileError(rejected.length ? `不支持的文件类型（仅支持 .txt / .epub）：${rejected.map(file => file.name).join("、")}` : "");
    const next = [...files()];
    for (const file of incoming.filter(file => /\.(txt|epub)$/i.test(file.name))) {
      if (!next.some(existing => existing.name === file.name && existing.size === file.size)) next.push(file);
    }
    if (next.length === files().length) return;
    if (!files().length || theme() === "__book__" && next.some(file => /\.txt$/i.test(file.name))) setTheme(next.every(file => /\.epub$/i.test(file.name)) ? "__book__" : "default");
    setFiles(next); setTitle(""); setAuthor("");
    void preview(next);
  }
  function remove(index: number) {
    if (submitting()) return;
    const next = files().filter((_, i) => i !== index);
    setFiles(next); setTitle(""); setAuthor("");
    // The preview endpoint restages the complete batch and invalidates old tokens.
    void preview(next);
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (disabled()) return;
    // Read successful controls before disabling build settings for the upload.
    const data = new FormData(form); data.delete("files");
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/ingest", { method: "POST", body: data, headers: { Accept: "application/json", "HX-Request": "true" } });
      const redirect = response.headers.get("HX-Redirect") || (response.redirected && new URL(response.url).pathname === "/login" ? response.url : null);
      if (redirect) {
        const { toast, cleanUrl } = flashFromUrl(new URL(redirect, "http://bindery.invalid").href);
        if (toast) showToast(toast.message, toast.kind);
        clear();
        await mutation.router.navigate({ href: cleanUrl });
        await mutation.router.invalidate();
        return;
      }
      const body = await response.json(); setError(body.error || body.detail || "入库失败，请稍后重试。");
    } catch (e) { setError(e instanceof Error ? e.message : "入库失败，请稍后重试。"); }
    finally { setSubmitting(false); }
  }
  return <div class="ingest-page"><div class="page-head"><div><h1>入库</h1><p class="muted">TXT 按切章规则生成 EPUB；EPUB 直接入库。</p></div>
    <Show when={props.jobs}>{jobs => <RecentJobs data={jobs()} open={!!props.jobsOpen} onOpen={() => props.openJobs?.()} onClose={() => props.closeJobs?.()} />}</Show>
  </div>
    <form ref={form} action="/ingest" method="post" enctype="multipart/form-data" onSubmit={submit} class="ingest-layout">
      <input type="hidden" name="dedupe_mode" value={duplicates() ? "normalize" : "keep"} />
      <div class="ingest-files">
        <Show when={files().length}><div class="ingest-selected-heading"><h2>已选 {files().length} 个文件</h2><Button variant="quiet" disabled={submitting()} onClick={clear}>清空</Button></div></Show>
        <label class={`ingest-dropzone ${files().length ? "is-compact" : ""} ${dragging() ? "is-dragging" : ""}`} tabindex={0} aria-label="选择 TXT 或 EPUB 文件" aria-disabled={submitting() ? "true" : undefined}
          onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && !submitting()) { event.preventDefault(); input.click(); } }}
          onDragOver={event => { event.preventDefault(); if (!submitting()) setDragging(true); }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={event => { event.preventDefault(); setDragging(false); add(Array.from(event.dataTransfer?.files || [])); }}>
          <input ref={input} class="ingest-file-input" type="file" name="files" accept=".txt,.epub" multiple disabled={submitting()} tabindex={-1} onChange={() => { add(Array.from(input.files || [])); input.value = ""; }} />
          <Show when={!files().length} fallback={<span>继续添加，或拖入更多文件</span>}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" stroke="currentColor" stroke-width="1.5" /></svg><span>把文件拖到这里，或 <strong>选择文件</strong></span><small class="muted">支持 .txt / .epub，可多选</small></Show>
        </label>
        <Show when={!files().length}><p class="muted ingest-dropzone-hint">选择文件后自动解析书名、作者和目录，确认无误再入库。</p></Show>
        <Show when={fileError()}><p role="alert" class="field-error">{fileError()}</p></Show>
        <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show>
        <Show when={parseFailed()}><Button variant="secondary" onClick={() => void preview()} disabled={busy() || submitting()}>重新解析</Button></Show>
        <Show when={busy()}><p class="muted">正在解析…</p></Show>
        <div id="ingest-preview"><UploadPreviews previews={previews()} onRemove={remove} disabled={submitting()} override={previews().length === 1 && previews()[0]?.format === "TXT" ? <div class="ingest-fields"><TextField name="title" label="书名（TXT 可选覆盖）" value={title()} disabled={submitting()} onInput={e => setTitle(e.currentTarget.value)} /><TextField name="author" label="作者（TXT 可选覆盖）" value={author()} disabled={submitting()} onInput={e => setAuthor(e.currentTarget.value)} /></div> : undefined} /></div>
      </div>
      <section class="ingest-settings"><h2>构建设置</h2><div class="ingest-setting-fields">
        <Select name="rule_template" label="切章规则（仅 TXT）" disabled={submitting()} onChange={() => { if (files().length) void preview(); }} hint="用于 TXT 切章；EPUB 入库会忽略。"><For each={options.rules}>{rule => <option value={rule.rule_id}>{rule.name} · v{rule.version}</option>}</For></Select>
        <Select name="theme_template" label="渲染主题" disabled={submitting()} value={theme()} onChange={e => setTheme(e.currentTarget.value)} hint="主题 CSS 会作为最后一层追加；本书 CSS 优先生效。"><For each={options.themes}>{theme => <option value={theme.theme_id}>{theme.name} · v{theme.version}</option>}</For><option value="__book__">保持书籍样式（仅 EPUB）</option></Select>
      </div><details><summary>高级：追加本批书籍的 CSS</summary><Button variant="quiet" size="sm" disabled={submitting()} onClick={() => setCss(formatCss(css()))}>格式化</Button><Textarea name="custom_css" label="本书 CSS" disabled={submitting()} rows={8} value={css()} onInput={event => setCss(event.currentTarget.value)} hint="这段 CSS 会追加在主题之后，优先生效。" /></details>
        <div class="ingest-submit"><Button type="submit" disabled={disabled()}>{submitting() ? "入库中…" : files().length ? `开始入库 · ${valid().length} 本` : "开始入库"}</Button><p role="status" aria-live="polite">{status()}</p></div>
      </section>
    </form>
  </div>;
}
