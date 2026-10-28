import TablerChevronDown from "~icons/tabler/chevron-down";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { AddCoverTile, Button, CenterDialog, GeneratedCover, Icon, SegmentedControl } from "../../ui";
import { Link } from "../../shared/spa-link";
import type { Preview } from "../../server/ingest/preview";

export function UploadPreviews(props: { previews: Preview[]; onRemove?: (index: number) => void; onAdd?: () => void; disabled?: boolean; override?: JSX.Element }) {
  return <div class="ingest-cover-wall"><For each={props.previews}>{(item, index) => <UploadBook item={item} disabled={props.disabled} onRemove={props.onRemove ? () => props.onRemove?.(index()) : undefined} override={props.override} />}</For>
    <Show when={props.onAdd}><AddCoverTile label={props.previews.length ? "继续添加" : undefined} onClick={() => { if (!props.disabled) props.onAdd?.(); }} /></Show>
    <Show when={!props.previews.length && props.onAdd}><For each={[1, .75, .5, .3, .15]}>{opacity => <div class="ingest-ghost-cover" aria-hidden="true" style={{ opacity: String(opacity) }} />}</For></Show>
  </div>;
}
function UploadBook(props: { item: Preview; disabled?: boolean; onRemove?: () => void; override?: JSX.Element }) {
  const [open, setOpen] = createSignal(false), [keep, setKeep] = createSignal("normalize");
  const id = createUniqueId();
  const title = () => props.item.error ? props.item.filename : props.item.title || props.item.filename;
  const state = () => props.item.error ? "unparseable" as const : props.item.duplicates.length ? "duplicate" as const : undefined;
  const label = () => `查看《${title()}》解析结果${props.item.error ? "（无法解析，不会入库）" : props.item.duplicates.length ? keep() === "keep" ? "（疑似重复，将新建一本）" : "（疑似重复，默认归入已有书籍）" : ""}`;
  const cover = (large = false) => <GeneratedCover book_id={props.item.filename} title={title()} author={props.item.author} state={state()} large={large} />;
  return <article class={`ingest-book ${props.item.error ? "is-error" : ""}`} data-preview-format={props.item.format} data-preview-title={props.item.title || ""} data-preview-author={props.item.author || ""} data-preview-filename={props.item.filename} data-preview-error={props.item.error ? "1" : undefined} data-upload-token={!props.item.error ? props.item.upload_token || undefined : undefined} data-duplicate-hit={props.item.duplicates.length ? "1" : undefined}>
    <button type="button" class="ingest-cover-trigger" aria-label={label()} aria-haspopup="dialog" aria-controls={id} aria-expanded={open() ? "true" : "false"} onClick={() => setOpen(true)}>{cover()}</button>
    <button type="button" class="ingest-book-caption" aria-label={label()} aria-haspopup="dialog" aria-controls={id} aria-expanded={open() ? "true" : "false"} onClick={() => setOpen(true)}><strong>{title()}</strong><Show when={!props.item.error} fallback={<span class="ingest-book-error">无法解析</span>}><span class="ingest-book-meta" data-duplicate={props.item.duplicates.length ? "true" : undefined}>{props.item.author}{props.item.author ? " · " : ""}{props.item.chapters} 章</span><Show when={props.item.duplicates.length}><span class="ingest-book-dupe">{keep() === "keep" ? "新建一本" : "归入已有"}</span></Show></Show></button>
    <Show when={!props.item.error && props.item.upload_token}><input type="hidden" name="upload_tokens" value={props.item.upload_token!} /><Show when={props.item.duplicates.length && keep() === "keep"}><input type="hidden" name="dedupe_keep_tokens" value={props.item.upload_token!} /></Show></Show>
    <CenterDialog id={id} class="ingest-book-dialog" open={open()} title={title()} closeLabel="关闭解析结果" onClose={() => setOpen(false)} actions={<><Show when={props.onRemove}><Button variant="quiet" disabled={props.disabled} aria-label={`移除 ${props.item.filename}`} onClick={() => { setOpen(false); props.onRemove?.(); }}>移除这本</Button></Show><Button size="lg" onClick={() => setOpen(false)}>完成</Button></>}>
      <div class="ingest-book-detail"><div class="ingest-detail-cover">{cover(true)}</div><div class="ingest-book-fields">
        <div class="ingest-book-heading"><h2 class="ingest-detail-title">{title()}</h2>
          <Show when={!props.item.error}><p>{props.item.author}{props.item.author ? " · " : ""}{props.item.format === "TXT" && props.item.volumes > 0 ? `${props.item.volumes} 卷 · ` : ""}{props.item.chapters} 章</p></Show>
        </div>
        <Show when={props.item.error}><div class="field-error"><p role="alert">{props.item.error}</p><p>这本不会入库，可以移除后重新选择文件。</p></div></Show>
        <Show when={!props.item.error && props.item.duplicates.length}><div class="ingest-duplicate"><p>书库里已经有<Show when={props.item.duplicates.length === 1} fallback="：">一本 </Show><For each={props.item.duplicates}>{(duplicate, index) => <>{index() ? "、" : ""}<Link href={`/book/${duplicate.book_id}`}>《{duplicate.title}》{duplicate.author ? `（${duplicate.author}）` : ""}</Link></>}</For>。</p><SegmentedControl label="重复书籍的处理方式" value={keep()} options={[{ value: "normalize", label: "归入已有" }, { value: "keep", label: "新建一本" }]} disabled={props.disabled} onChange={setKeep} /></div></Show>
        {props.override}
        <Show when={props.item.toc.length}><section class="ingest-toc-section"><h3 class="ingest-field-title">目录</h3><ol class="ingest-toc"><For each={props.item.toc.slice(0, 6)}>{title => <li>{title}</li>}</For><Show when={props.item.chapters > 6}><li class="ingest-toc-more">…… 共 {props.item.chapters} 章</li></Show></ol></section></Show>
        <details class="ingest-file-details"><summary>文件信息<Icon icon={TablerChevronDown} size={16} class="ui-summary-chevron" /></summary><dl><dt>格式</dt><dd>{props.item.format}</dd><dt>文件名</dt><dd>{props.item.filename}</dd><Show when={props.item.output}><dt>输出文件</dt><dd>{props.item.output}</dd></Show></dl></details>
      </div></div>
    </CenterDialog>
  </article>;
}
