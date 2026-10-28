import { createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isRedirect } from "@tanstack/solid-router";
import { Button, CenterDialog, ConfirmDialog, Icon, TextField } from "../../ui";
import { showToast } from "../../client/toast";
import { useMutation } from "../../shared/client-mutation";
import type { EditorData, RulePreviewData } from "../../server/catalog/templates";
import { formatCssText, themePreviewDocument } from "./client";
import { removeTemplate, saveTemplate, testTemplate } from "./mutations";
import "./settings-templates.css";

export function RulePreview(props: { preview: RulePreviewData }) {
  return <div id="rule-test-preview" class="catalog-test-result" aria-live="polite"><Show when={props.preview} fallback={<p class="muted">粘贴一段文本后，这里会列出识别到的卷和章。</p>}>
    <p class="catalog-test-count">识别出 <strong>{props.preview?.volumes}</strong> 卷 <strong>{props.preview?.chapters}</strong> 章</p>
    <ol class="catalog-toc"><For each={props.preview?.toc || []}>{title => <li>{title}</li>}</For></ol>
  </Show></div>;
}
export function TemplateDelete(props: { kind: "rules" | "themes"; id: string; disabled?: boolean }) {
  const [open, setOpen] = createSignal(false), mutation = useMutation();
  return <><form action={`/${props.kind}/${encodeURIComponent(props.id)}/delete`} method="post" onSubmit={event => { event.preventDefault(); if (!props.disabled) setOpen(true); }}>
    <Button type="submit" variant="quiet-danger" class="catalog-delete" aria-label={props.kind === "rules" ? "删除这条规则" : "删除这个主题"} title="删除" disabled={mutation.busy() || props.disabled}><Icon name="trash" size={18} /></Button>
  </form><ConfirmDialog open={open()} title={props.kind === "rules" ? "删除规则模板" : "删除主题模板"} danger onClose={() => { if (!mutation.busy()) setOpen(false); }} onConfirm={() => mutation.run(() => removeTemplate({ data: { kind: props.kind, id: props.id } }), async result => {
    setOpen(false); await mutation.router.navigate({ href: result.target }); await mutation.router.invalidate();
  }, "已删除模板", true).then(() => {})} confirmLabel="删除">
    <p>{props.kind === "rules" ? "确定要删除这个规则模板吗？" : "确定要删除这个主题模板吗？"}</p>
  </ConfirmDialog></>;
}
export function Editor(props: { data: EditorData; kind: "rules" | "themes"; usage?: { book_count: number; archived_count: number }; rebuild?: JSX.Element }) {
  const mutation = useMutation();
  const [previewTokens, setPreviewTokens] = createSignal(""), [hydrated, setHydrated] = createSignal(false);
  onSettled(() => {
    setHydrated(true);
    if (typeof window === "undefined" || !window.getComputedStyle) return;
    const styles = window.getComputedStyle(document.documentElement);
    setPreviewTokens(["--color-surface", "--color-ink", "--color-ink-4", "--color-accent", "--font-display"].map(token => `${token}:${styles.getPropertyValue(token)};`).join(""));
  });
  const [raw, setRaw] = createSignal(untrack(() => props.data.raw)), [saved, setSaved] = createSignal(untrack(() => props.data.raw)), [message, setMessage] = createSignal(untrack(() => props.data.error || (props.data.saved ? "已保存" : "")));
  const [naming, setNaming] = createSignal<"rename" | "copy" | null>(null), [name, setName] = createSignal("");
  const [preview, setPreview] = createSignal<RulePreviewData>(null), [testError, setTestError] = createSignal(""), [testing, setTesting] = createSignal(false);
  let testForm!: HTMLFormElement, debounce: ReturnType<typeof setTimeout> | undefined, sequence = 0;
  onCleanup(() => { clearTimeout(debounce); sequence++; });
  async function save(event: SubmitEvent) {
    event.preventDefault(); setMessage("");
    await mutation.run(() => saveTemplate({ data: { kind: props.kind, id: props.data.id, raw: raw(), ...(naming() ? { operation: naming()!, name: name() } : {}) } }), async data => {
      setRaw(data.raw); setMessage(data.error || "");
      if (data.error) { showToast(data.error, "error"); return; }
      setSaved(data.raw); setNaming(null);
      showToast("已保存");
      if (data.target) await mutation.router.navigate({ href: data.target });
      await mutation.router.invalidate();
    });
  }
  async function runTest(manual = false) {
    clearTimeout(debounce); const current = ++sequence; setTesting(true);
    try {
      const sample = String(new FormData(testForm).get("sample") || "");
      const result = await testTemplate({ data: { id: props.data.id, sample } });
      if (current === sequence) { setPreview(result); setTestError(""); if (manual) showToast("测试完成"); }
    } catch (error) {
      if (isRedirect(error)) { await mutation.router.navigate({ href: error.options.href || "/login" }); return; }
      if (current === sequence) { const message = error instanceof Error ? error.message : "测试失败"; setTestError(message); showToast(message, "error"); }
    } finally { if (current === sequence) setTesting(false); }
  }
  function format() {
    if (props.kind === "themes") { setRaw(formatCssText(raw())); return; }
    try { setRaw(raw().trim() ? JSON.stringify(JSON.parse(raw()), null, 2) : ""); setMessage(""); }
    catch { setMessage("JSON 格式错误，无法格式化"); }
  }
  const dirty = () => raw() !== saved(), builtIn = () => props.data.id === "default", formId = () => `${props.kind}-editor-form`;
  const inUse = () => !props.usage || props.usage.book_count + props.usage.archived_count > 0;
  function openName(operation: "rename" | "copy") { setName(operation === "copy" ? `${props.data.name} 副本` : props.data.name); setNaming(operation); }
  return <article class="settings-template-editor" id={props.kind === "rules" ? "rule-editor" : "theme-editor"}>
    <header class="catalog-editor-head">
      <h2>{props.data.name}<small>v{props.data.version}{builtIn() ? " · 内置" : ""}</small></h2>
      <Show when={dirty()}><span class="catalog-dirty" aria-live="polite"><span class="catalog-dirty-dot" aria-hidden="true" />有修改</span></Show>
      <span class="catalog-head-spacer" aria-hidden="true" />
      <div class="catalog-editor-actions">
        <Button variant="quiet" disabled={mutation.busy()} onClick={() => openName("copy")}>另存为</Button>
        <Button variant="quiet" disabled={mutation.busy()} onClick={() => openName("rename")}>重命名</Button>
        {props.rebuild}
        <Show when={!builtIn()}><TemplateDelete kind={props.kind} id={props.data.id} disabled={inUse()} /></Show>
        <Button type="submit" form={formId()} class="catalog-save" disabled={mutation.busy() || (hydrated() && !dirty())}>{mutation.busy() ? "保存中…" : "保存"}</Button></div>
    </header>
    <Show when={message()}><p role="alert" class="notice">{message()}</p></Show>
    <div class="catalog-columns">
      <form id={formId()} action={`/${props.kind}/${encodeURIComponent(props.data.id)}/editor`} method="post" onSubmit={save} class="catalog-pane">
        <div class="catalog-pane-head"><label for={`${formId()}-code`}>{props.kind === "rules" ? "规则 JSON" : "主题 CSS"}</label><div class="catalog-pane-actions"><Button variant="quiet" disabled={mutation.busy() || !dirty()} onClick={() => { setRaw(saved()); setMessage(""); }}>还原</Button><Button variant="quiet" onClick={format} disabled={mutation.busy()}>格式化</Button></div></div>
        <textarea id={`${formId()}-code`} class="catalog-code" name={props.kind === "rules" ? "config_json" : "css"} value={raw()} onInput={event => setRaw(event.currentTarget.value)} spellcheck={false} wrap="off" disabled={mutation.busy()} />
      </form>
      <Show when={props.kind === "rules"} fallback={<section class="catalog-pane"><div class="catalog-pane-head"><h3>预览</h3><span class="muted">随编辑实时更新，未保存也能看</span></div><iframe title="主题 CSS 实时预览" sandbox="" referrerpolicy="no-referrer" srcdoc={themePreviewDocument(raw(), previewTokens())} /></section>}>
        <section class="catalog-pane"><div class="catalog-pane-head"><label for={`${formId()}-sample`}>试切</label><span class="muted">粘贴一段 TXT，输入后自动运行</span></div>
          <form ref={testForm} action="/rules/test" method="post" onSubmit={event => { event.preventDefault(); void runTest(true); }}>
            <input type="hidden" name="rule_template" value={props.data.id} /><textarea id={`${formId()}-sample`} class="catalog-sample" name="sample" rows={5} placeholder="粘贴一段 TXT 文本" onInput={() => { clearTimeout(debounce); debounce = setTimeout(() => void runTest(), 300); }} />
          </form><Show when={testing()}><p class="muted">正在试切…</p></Show><Show when={testError()}><p role="alert" class="field-error">{testError()}</p></Show><RulePreview preview={preview()} /></section>
      </Show>
    </div>
    <Show when={!builtIn() && inUse()}><p class="catalog-delete-note muted">{props.usage ? "在库或已归档的书仍在使用，不能删除。" : "请回到模板列表查看使用情况后删除。"}</p></Show>
    <CenterDialog open={Boolean(naming())} title={naming() === "copy" ? "另存为" : "重命名"} onClose={() => { if (!mutation.busy()) setNaming(null); }}>
      <Show when={naming()}><form action={`/${props.kind}/${encodeURIComponent(props.data.id)}/editor`} method="post" onSubmit={save} class="settings-template-name-form">
        <input type="hidden" name="operation" value={naming() || "rename"} /><input type="hidden" name={props.kind === "rules" ? "config_json" : "css"} value={raw()} />
        <TextField label="模板名称" name="name" required maxlength={80} value={name()} onInput={event => setName(event.currentTarget.value)} disabled={mutation.busy()} />
        <p class="muted">将同时保存当前编辑内容。另存为不会修改原模板。</p>
        <Show when={message()}><p role="alert">{message()}</p></Show>
        <div class="catalog-editor-actions"><Button variant="quiet" disabled={mutation.busy()} onClick={() => setNaming(null)}>取消</Button><Button type="submit" disabled={mutation.busy()}>确认</Button></div>
      </form></Show>
    </CenterDialog>
  </article>;
}
