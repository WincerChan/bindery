import TablerBraces from "~icons/tabler/braces";
import TablerChevronDown from "~icons/tabler/chevron-down";
import TablerUpload from "~icons/tabler/upload";
import { createSignal, createUniqueId, onCleanup, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Icon, PageIntro, SelectPill, Textarea, TextField, ToggleChip, Toolbar } from "../../ui";
import { IngestFirstPage } from "./first-page";
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
  const fileInputId = createUniqueId();
  const [files, setFiles] = createSignal<File[]>([]), [previews, setPreviews] = createSignal<Preview[]>([]);
  const [busy, setBusy] = createSignal(false), [submitting, setSubmitting] = createSignal(false), [dragging, setDragging] = createSignal(false);
  const [error, setError] = createSignal(untrack(() => props.error || "")), [parseFailed, setParseFailed] = createSignal(false), [fileError, setFileError] = createSignal("");
  const [title, setTitle] = createSignal(""), [author, setAuthor] = createSignal(""), [theme, setTheme] = createSignal("default"), [css, setCss] = createSignal(untrack(() => props.custom_css || ""));
  // Jobs loader refreshes must not replace build settings or the selected files.
  const options = untrack(() => props.options);
  const [rule, setRule] = createSignal(options.rules[0]?.rule_id || "default");
  const [cssOpen, setCssOpen] = createSignal(untrack(() => !!props.custom_css)), [enhanced, setEnhanced] = createSignal(false);
  onSettled(() => { setEnhanced(true); });
  const valid = () => previews().filter(item => !item.error && item.upload_token);
  const duplicates = () => valid().filter(item => item.duplicates.length).length;
  const firstBook = () => valid()[0];
  const disabled = () => !valid().length || busy() || submitting() || parseFailed();
  const status = () => submitting() ? "正在提交…" : busy() ? "正在解析…" : !files().length ? "先选择文件" : parseFailed() ? "解析失败，请重新解析" : duplicates() ? `${duplicates()} 本疑似重复：默认归入已有书籍，可点开书籍选择「新建一本」` : valid().length ? `已就绪 · ${valid().length} 本可入库` : "没有可入库的文件，请移除错误项或重新选择";
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
  const content = (jobsTrigger?: (variant?: "pill" | "hero") => JSX.Element) => <form ref={form} action="/ingest" method="post" enctype="multipart/form-data" onSubmit={submit} data-enhanced={enhanced() ? "true" : "false"} class={`ingest-layout ${dragging() ? "is-dragging" : ""}`}
    onDragOver={event => { event.preventDefault(); if (!submitting()) setDragging(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); add(Array.from(event.dataTransfer?.files || [])); }}>
    <input type="hidden" name="dedupe_mode" value={duplicates() ? "normalize" : "keep"} />
    <input ref={input} id={fileInputId} class="ingest-file-input" aria-label="选择 TXT 或 EPUB 文件" type="file" name="files" accept=".txt,.epub" multiple disabled={submitting()} onChange={() => { add(Array.from(input.files || [])); input.value = ""; }} />
    <Show when={!files().length}><Button type="submit" class="ingest-fallback-submit" disabled={enhanced() && disabled()}>开始入库</Button></Show>
    <PageIntro class={files().length ? "" : "ingest-intro-empty"} eyebrow={files().length ? `入库 · 已选 ${files().length} 个文件` : "入库"} title={files().length ? <>这次放进书库的，<br />是下面这几本。</> : "把书放进来。"}
      description={files().length ? "这是按当前主题排出的第一页，换规则或主题会跟着变。" : "拖到这一页任何地方，或选择文件。支持 TXT 和 EPUB，可多选。"}
      actions={<div class="ingest-hero-actions" data-staged={files().length ? "true" : "false"}>
        <Show when={!files().length}>
          <label for={fileInputId} class="btn btn-primary btn-lg ingest-picker" aria-disabled={submitting() ? "true" : undefined}><Icon icon={TablerUpload} size={16} /><span>选择文件</span></label>
          {jobsTrigger?.("hero")}
        </Show>
        <Show when={files().length}>
          <Button type="submit" size="lg" class="ingest-hero-submit" count={`${valid().length} 本`} disabled={enhanced() && disabled()}>{submitting() ? "入库中…" : "开始入库"}</Button>
          <Button variant="quiet" size="lg" class="ingest-hero-clear" disabled={submitting()} onClick={clear}>清空</Button>
        </Show>
      </div>}
      visual={<Show when={files().length}><IngestFirstPage token={firstBook()?.upload_token} title={firstBook()?.title || firstBook()?.filename || ""} rule={rule()} theme={theme()} unavailable={!busy() && !!previews().length && !valid().length} /></Show>} />
    <div class="ingest-toolbar-row" data-empty={files().length ? undefined : "true"}><Toolbar label="构建设置"><SelectPill class="ingest-select-pill" name="rule_template" label="切章" value={rule()} disabled={submitting()} options={options.rules.map(rule => ({ value: rule.rule_id, label: `${rule.name} · v${rule.version}` }))} onChange={value => { setRule(value); void preview(); }} /><SelectPill class="ingest-select-pill" name="theme_template" label="主题" value={theme()} disabled={submitting()} options={[...options.themes.map(theme => ({ value: theme.theme_id, label: `${theme.name} · v${theme.version}` })), { value: "__book__", label: "保持书籍样式（仅 EPUB）" }]} onChange={setTheme} /><ToggleChip class="ingest-css-chip" selected={cssOpen()} aria-label="追加本批 CSS" aria-expanded={cssOpen() ? "true" : "false"} aria-controls="ingest-css" onClick={() => setCssOpen(!cssOpen())}><Icon icon={TablerBraces} size={16} /><span>CSS</span></ToggleChip></Toolbar><Show when={files().length}>{jobsTrigger?.()}</Show></div>
    <details id="ingest-css" class="ingest-css" open={cssOpen()} onToggle={event => setCssOpen(event.currentTarget.open)}><summary>高级：追加本批书籍的 CSS<Icon icon={TablerChevronDown} size={16} class="ui-summary-chevron" /></summary><p>切章规则仅用于 TXT；EPUB 保留原目录。主题之后会追加本书 CSS。</p><Button variant="quiet" disabled={submitting()} onClick={() => setCss(formatCss(css()))}>格式化</Button><Textarea name="custom_css" label="本书 CSS" disabled={submitting()} rows={8} value={css()} onInput={event => setCss(event.currentTarget.value)} hint="这段 CSS 会追加在主题之后，优先生效。第一页预览暂不包含本批追加的 CSS。" /></details>
    <Show when={fileError()}><p role="alert" class="field-error">{fileError()}</p></Show>
    <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show>
    <Show when={parseFailed()}><Button variant="secondary" onClick={() => void preview()} disabled={busy() || submitting()}>重新解析</Button></Show>
    <Show when={busy()}><p class="ingest-status">正在解析…</p></Show>
    <div id="ingest-preview"><UploadPreviews previews={previews()} onRemove={remove} onAdd={() => input.click()} disabled={submitting()} override={previews().length === 1 && previews()[0]?.format === "TXT" ? <div class="ingest-fields"><TextField name="title" label="书名（TXT 可选覆盖）" value={title()} disabled={submitting()} onInput={e => setTitle(e.currentTarget.value)} /><TextField name="author" label="作者（TXT 可选覆盖）" value={author()} disabled={submitting()} onInput={e => setAuthor(e.currentTarget.value)} /></div> : undefined} /></div>
    <p class="sr-only" role="status" aria-live="polite">{status()}</p>
  </form>;
  // The jobs sheet owns retry/cleanup forms; keep it outside the multipart form.
  return <div class="ingest-page"><Show when={props.jobs} fallback={content()}>{jobs => <RecentJobs data={jobs()} open={!!props.jobsOpen} onOpen={() => props.openJobs?.()} onClose={() => props.closeJobs?.()} layout={(trigger, sheet) => <>{content(trigger)}{sheet}</>} />}</Show></div>;
}
