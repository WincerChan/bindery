import { createSignal, For, onCleanup, Show } from "solid-js";
import { Button, ConfirmDialog, Textarea } from "../../ui";
import { showToast } from "../../client/toast";
import type { EditorData, RulePreviewData } from "../../server/catalog/templates";
import { catalogRequest, formatCssText, themePreviewDocument } from "./client";

export function RulePreview(props: { preview: RulePreviewData }) {
  return <div id="rule-test-preview" aria-live="polite"><Show when={props.preview} fallback={<p class="muted">尚未运行测试。</p>}>
    <p>卷数量 <strong>{props.preview?.volumes}</strong> · 章数量 <strong>{props.preview?.chapters}</strong></p><h3>目录预览</h3>
    <ol><For each={props.preview?.toc || []}>{title => <li>{title}</li>}</For></ol>
  </Show></div>;
}
export function TemplateDelete(props: { kind: "rules" | "themes"; id: string }) {
  const [open, setOpen] = createSignal(false);
  let form!: HTMLFormElement;
  return <><form ref={form} action={`/${props.kind}/${encodeURIComponent(props.id)}/delete`} method="post" onSubmit={event => { event.preventDefault(); setOpen(true); }}>
    <Button type="submit" variant="danger" disabled={props.id === "default"}>删除</Button>
  </form><ConfirmDialog open={open()} title={props.kind === "rules" ? "删除规则模板" : "删除主题模板"} danger onClose={() => setOpen(false)} onConfirm={() => form.submit()} confirmLabel="删除">
    <p>{props.kind === "rules" ? "确定要删除这个规则模板吗？" : "确定要删除这个主题模板吗？"}</p>
  </ConfirmDialog></>;
}
export function Editor(props: { data: EditorData; kind: "rules" | "themes" }) {
  const [raw, setRaw] = createSignal(props.data.raw), [message, setMessage] = createSignal(props.data.error || (props.data.saved ? "已保存" : "")), [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<RulePreviewData>(null), [testError, setTestError] = createSignal("");
  let testForm!: HTMLFormElement, debounce: ReturnType<typeof setTimeout> | undefined, abort: AbortController | undefined, sequence = 0;
  onCleanup(() => { clearTimeout(debounce); abort?.abort(); sequence++; });
  async function save(event: SubmitEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const body = new FormData(event.currentTarget as HTMLFormElement);
      const data = await catalogRequest<EditorData>(`/${props.kind}/${encodeURIComponent(props.data.id)}/editor`, body);
      setRaw(data.raw); setMessage(data.error || "已保存");
      if (data.saved) showToast("已保存");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  }
  async function runTest() {
    clearTimeout(debounce); abort?.abort(); abort = new AbortController(); const current = ++sequence;
    try { const result = await catalogRequest<RulePreviewData>("/rules/test", new FormData(testForm), abort.signal); if (current === sequence) { setPreview(result); setTestError(""); } }
    catch (error) { if (current === sequence && !abort?.signal.aborted) setTestError(error instanceof Error ? error.message : "测试失败"); }
  }
  function format() {
    if (props.kind === "themes") { setRaw(formatCssText(raw())); return; }
    try { setRaw(raw().trim() ? JSON.stringify(JSON.parse(raw()), null, 2) : ""); setMessage(""); }
    catch { setMessage("JSON 格式错误，无法格式化"); }
  }
  return <article class="catalog-editor" id={props.kind === "rules" ? "rule-editor" : "theme-editor"}>
    <div class="catalog-heading"><div><h2>{props.data.name} <small>v{props.data.version}</small></h2><p class="muted">{props.data.description || "—"}</p></div><TemplateDelete kind={props.kind} id={props.data.id} /></div>
    <Show when={message()}><p role="status" class="notice">{message()}</p></Show>
    <div class="catalog-columns">
      <form action={`/${props.kind}/${encodeURIComponent(props.data.id)}/editor`} method="post" onSubmit={save} class="form-stack">
        <Textarea label={props.kind === "rules" ? "规则 JSON" : "主题 CSS"} name={props.kind === "rules" ? "config_json" : "css"} value={raw()} onInput={event => setRaw(event.currentTarget.value)} rows={18} spellcheck={false} disabled={busy()} />
        <div class="catalog-actions"><Button variant="secondary" onClick={format} disabled={busy()}>{props.kind === "rules" ? "格式化 JSON" : "格式化"}</Button><Button type="submit" disabled={busy()}>{busy() ? "保存中…" : "保存"}</Button></div>
      </form>
      <Show when={props.kind === "rules"} fallback={<section><h3>实时预览</h3><iframe title="主题 CSS 实时预览" sandbox="" referrerpolicy="no-referrer" srcdoc={themePreviewDocument(raw())} /><p class="muted">预览仅用于检查排版效果（不会影响页面自身样式）。</p></section>}>
        <section><h3>规则测试</h3><p class="muted">使用当前已保存模板运行</p><form ref={testForm} action="/rules/test" method="post" onSubmit={event => { event.preventDefault(); void runTest(); }} class="form-stack">
          <input type="hidden" name="rule_template" value={props.data.id} /><Textarea name="sample" label="示例文本" rows={8} placeholder="粘贴一段文本（用于验证切章效果）" onInput={() => { clearTimeout(debounce); debounce = setTimeout(() => void runTest(), 300); }} />
          <Button type="submit">运行测试</Button>
        </form><Show when={testError()}><p role="alert">{testError()}</p></Show><RulePreview preview={preview()} /></section>
      </Show>
    </div>
  </article>;
}
