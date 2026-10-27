import { createEffect, createSignal, Show } from "solid-js";

type FirstPage = { section_title: string; volume_title: string | null; html: string };

/** Staged content is never inserted into the application's document. */
export function IngestFirstPage(props: { token?: string | null; title: string; rule: string; theme: string; unavailable?: boolean }) {
  const [page, setPage] = createSignal<FirstPage | null>(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  createEffect(() => ({ token: props.token, rule: props.rule, theme: props.theme }), selection => {
    setPage(null); setError(""); setLoading(!!selection.token);
    if (!selection.token) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/ingest/first-page", {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ upload_token: selection.token, rule_id: selection.rule, theme_id: selection.theme }), signal: controller.signal,
        });
        if (!response.ok || response.redirected) throw new Error("暂时无法预览第一页，请稍后重试。");
        const result: FirstPage | { error: string } = await response.json();
        if (controller.signal.aborted) return;
        if ("error" in result) setError(result.error); else setPage(result);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "暂时无法预览第一页。");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  });
  return <figure class="ingest-first-page" aria-label={`${props.title ? `《${props.title}》` : ""}按当前主题排出的第一页`} aria-busy={loading() ? "true" : "false"}>
    <Show when={page()} fallback={<p role="status">{loading() ? "正在排出第一页…" : error() || (props.unavailable ? "没有可预览的书籍，请移除无法解析的文件后重试。" : "解析完成后，这里会显示第一页。")}<Show when={error()}><span>不影响已解析书籍入库。</span></Show></p>}>
      {value => <><figcaption><Show when={value().volume_title}><span>{value().volume_title}</span></Show><strong>{value().section_title}</strong></figcaption><iframe title={`《${props.title}》第一页`} sandbox="" srcdoc={value().html} /></>}
    </Show>
  </figure>;
}
