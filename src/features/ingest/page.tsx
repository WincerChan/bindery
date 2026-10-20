import { createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Button, Select, Textarea, TextField } from "../../ui";
import { formatCss } from "./css-format";
import { UploadPreviews } from "./preview";
import { RecentJobs } from "./jobs";
import type { JobsPayload, ingestOptions } from "../../server/ingest/queries";
import type { Preview } from "../../server/ingest/preview";
export function IngestPage(props: { options: ReturnType<typeof ingestOptions>; error?: string; custom_css?: string; jobs?: JobsPayload; jobsOpen?: boolean; openJobs?: () => unknown; closeJobs?: () => unknown; navigateJobs?: (href: string) => unknown }) {
  const [previews, setPreviews] = createSignal<Preview[]>([]), [busy, setBusy] = createSignal(false), [submitting, setSubmitting] = createSignal(false), [error, setError] = createSignal(untrack(() => props.error || "")), [feedback, setFeedback] = createSignal(""), [title, setTitle] = createSignal(""), [author, setAuthor] = createSignal(""), [theme, setTheme] = createSignal("default"), [css, setCss] = createSignal(untrack(() => props.custom_css || ""));
  // Keep build-setting options stable while jobs navigation replaces loader data.
  const options = untrack(() => props.options);
  let form!: HTMLFormElement, input!: HTMLInputElement, controller: AbortController | undefined;
  onCleanup(() => controller?.abort());
  async function preview() {
    controller?.abort(); const current = new AbortController(); controller = current;
    setBusy(true); setError(""); setPreviews([]);
    try {
      const data = new FormData(form); data.delete("upload_tokens");
      const response = await fetch("/ingest/preview", { method: "POST", body: data, headers: { Accept: "application/json" }, signal: current.signal });
      if (!response.ok) throw new Error(response.status === 413 ? "预览请求过大（413）：请减少单次文件数，或先压缩/拆分后再预览。" : `预览解析失败（HTTP ${response.status}），请稍后重试。`);
      const items: Preview[] = await response.json(); setPreviews(items);
      if (items.length === 1 && items[0]?.format === "TXT") { setTitle(items[0].title || ""); setAuthor(items[0].author || ""); }
    } catch (e) { if (!current.signal.aborted) setError(e instanceof Error ? e.message : "预览解析失败，请稍后重试。"); }
    finally { if (controller === current) setBusy(false); }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (busy() || submitting()) return;
    setSubmitting(true); setError("");
    try {
      const data = new FormData(form); if (previews().some(p => p.upload_token)) data.delete("files");
      const response = await fetch("/ingest", { method: "POST", body: data, headers: { Accept: "application/json", "HX-Request": "true" } });
      const redirect = response.headers.get("HX-Redirect"); if (redirect) { window.location.assign(redirect); return; }
      const body = await response.json(); setError(body.error || body.detail || "入库失败，请稍后重试。");
    } catch (e) { setError(e instanceof Error ? e.message : "入库失败，请稍后重试。"); }
    finally { setSubmitting(false); }
  }
  return <div class="ingest-page"><div class="page-head"><div><h1>入库</h1><p class="muted">TXT / EPUB</p></div>
      <Show when={props.jobs}>{jobs => <RecentJobs data={jobs()} open={!!props.jobsOpen} onOpen={() => props.openJobs?.()} onClose={() => props.closeJobs?.()} navigate={props.navigateJobs} />}</Show>
    </div>
    <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show>
    <form ref={form} action="/ingest" method="post" enctype="multipart/form-data" onSubmit={submit}>
      <input type="hidden" name="dedupe_mode" value={previews().some(p => p.duplicates.length) ? "normalize" : "keep"} />
      <label class="field"><span>上传 TXT/EPUB 文件</span><input ref={input} type="file" name="files" accept=".txt,.epub" multiple required={!previews().some(p => p.upload_token)} disabled={submitting()} onChange={() => {
        const files = Array.from(input.files || []); setPreviews([]); setTitle(""); setAuthor("");
        setFeedback(files.length ? `已选择 ${files.length} 个文件：${files.map(f => f.name).join("、")}` : "");
        setTheme(files.length && files.every(f => f.name.toLowerCase().endsWith(".epub")) ? "__book__" : "default");
        if (files.length) void preview();
      }} /></label>
      <p class="muted">TXT 会按规则切章生成 EPUB；EPUB 会直接入库（可选写回元数据）。</p>
      <Show when={feedback()}><p role="status">{feedback()}</p></Show>
      <Show when={previews().length === 1 && previews()[0]?.format === "TXT"}><div class="ingest-fields"><TextField name="title" label="书名（TXT 可选覆盖）" value={title()} onInput={e => setTitle(e.currentTarget.value)} /><TextField name="author" label="作者（TXT 可选覆盖）" value={author()} onInput={e => setAuthor(e.currentTarget.value)} /></div></Show>
      <section><h2>构建设置</h2><p class="muted">默认继承全局主题，可为本书追加 CSS（会写回到 EPUB）。</p><div class="ingest-fields">
        <Select name="rule_template" label="切章规则（仅 TXT）" hint="用于 TXT 切章；EPUB 入库会忽略。"><For each={options.rules}>{rule => <option value={rule.rule_id}>{rule.name} · v{rule.version}</option>}</For></Select>
        <Select name="theme_template" label="渲染主题" value={theme()} onChange={e => setTheme(e.currentTarget.value)} hint="主题 CSS 会作为最后一层追加；本书 CSS 优先生效。"><For each={options.themes}>{theme => <option value={theme.theme_id}>{theme.name} · v{theme.version}</option>}</For><option value="__book__">保持书籍样式（仅 EPUB）</option></Select>
      </div><details><summary>高级：针对本批导入书籍追加 CSS</summary><Button variant="quiet" size="sm" onClick={() => setCss(formatCss(css()))}>格式化</Button><Textarea name="custom_css" label="本书 CSS" rows={8} value={css()} onInput={event => setCss(event.currentTarget.value)} hint="这段 CSS 会追加在主题之后，优先生效。" /></details></section>
      <div class="ingest-actions"><Button variant="secondary" onClick={() => void preview()} disabled={busy() || submitting()}>{busy() ? "解析中..." : "预览解析"}</Button><Button type="submit" disabled={busy() || submitting()}>{submitting() ? "入库中..." : "开始入库"}</Button></div>
      <p role="status" aria-live="polite">{busy() ? "正在解析文件，请稍候..." : submitting() ? "正在提交入库任务，请稍候..." : ""}</p>
      <div id="ingest-preview"><UploadPreviews previews={previews()} /></div>
    </form>
  </div>;
}
