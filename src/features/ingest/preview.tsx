import { For, Show } from "solid-js";
import { Checkbox, EmptyState } from "../../ui";
import type { Preview } from "../../server/ingest/preview";
export function UploadPreviews(props: { previews: Preview[] }) {
  return <Show when={props.previews.length} fallback={<EmptyState title="没有可预览的内容。" />}><div class="ingest-previews"><For each={props.previews}>{item => <article class="ingest-preview" data-preview-format={item.format} data-preview-title={item.title || ""} data-preview-author={item.author || ""} data-preview-filename={item.filename} data-upload-token={item.upload_token || undefined} data-duplicate-hit={item.duplicates.length ? "1" : undefined}>
    <h3>{item.filename}</h3><Show when={item.upload_token}><input type="hidden" name="upload_tokens" value={item.upload_token!} /></Show>
    <Show when={item.error}><p role="alert" class="field-error">{item.error}</p></Show>
    <Show when={item.duplicates.length}><p>检测到疑似重复书籍：<For each={item.duplicates}>{duplicate => <a href={`/book/${duplicate.book_id}`}>{duplicate.title}（{duplicate.author}） </a>}</For>，请确认是否保留：</p><Checkbox name="dedupe_keep_tokens" value={item.upload_token || ""} label="保留（继续新建）" /></Show>
    <dl><div><dt>格式</dt><dd>{item.format}</dd></div><div><dt>识别标题</dt><dd>{item.title || "—"}</dd></div><div><dt>作者</dt><dd>{item.author || "未知"}</dd></div><div><dt>{item.format === "EPUB" ? "章节" : "卷/章"}</dt><dd>{item.format === "EPUB" ? item.chapters : `${item.volumes} / ${item.chapters}`}</dd></div><div><dt>输出文件</dt><dd>{item.output}</dd></div></dl>
    <Show when={item.toc.length}><h4>目录前 10 条</h4><ul><For each={item.toc}>{title => <li>{title}</li>}</For></ul></Show>
  </article>}</For></div></Show>;
}
