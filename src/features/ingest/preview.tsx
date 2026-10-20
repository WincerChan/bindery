import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Checkbox } from "../../ui";
import { Link } from "../../shared/spa-link";
import type { Preview } from "../../server/ingest/preview";
export function UploadPreviews(props: { previews: Preview[]; onRemove?: (index: number) => void; disabled?: boolean; override?: JSX.Element }) {
  return <div class="ingest-previews"><For each={props.previews}>{(item, index) => <article class="ingest-preview" data-preview-format={item.format} data-preview-title={item.title || ""} data-preview-author={item.author || ""} data-preview-filename={item.filename} data-upload-token={!item.error ? item.upload_token || undefined : undefined} data-duplicate-hit={item.duplicates.length ? "1" : undefined}>
    <div class="ingest-preview-heading"><span class="tag">{item.format}</span><strong>{item.title || item.filename}</strong><Show when={props.onRemove}><Button variant="quiet" disabled={props.disabled} aria-label={`移除 ${item.filename}`} onClick={() => props.onRemove?.(index())}>×</Button></Show></div>
    <p class="muted">{item.author || "未知作者"} · {item.format === "EPUB" ? `${item.chapters} 章` : `${item.volumes} 卷 / ${item.chapters} 章`} · {item.filename} / {item.output}</p>
    <Show when={!item.error && item.upload_token}><input type="hidden" name="upload_tokens" value={item.upload_token!} /></Show>
    <Show when={item.error}><p role="alert" class="field-error">{item.error}</p></Show>
    <Show when={!item.error && item.duplicates.length}><div class="ingest-duplicate"><p>检测到疑似重复书籍：<For each={item.duplicates}>{duplicate => <Link href={`/book/${duplicate.book_id}`}>{duplicate.title}（{duplicate.author}） </Link>}</For></p><Checkbox name="dedupe_keep_tokens" value={item.upload_token || ""} disabled={props.disabled} label="仍然新建一本" /></div></Show>
    <Show when={item.toc.length}><details><summary>目录前 10 条</summary><ol><For each={item.toc.slice(0, 10)}>{title => <li>{title}</li>}</For></ol></details></Show>
    {props.override}
  </article>}</For></div>;
}
