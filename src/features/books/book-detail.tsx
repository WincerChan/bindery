import TablerCheck from "~icons/tabler/check";
import TablerX from "~icons/tabler/x";
import TablerArrowUpRight from "~icons/tabler/arrow-up-right";
import TablerChevronDown from "~icons/tabler/chevron-down";
import TablerDeviceTablet from "~icons/tabler/device-tablet";
import TablerDownload from "~icons/tabler/download";
import TablerPencil from "~icons/tabler/pencil";
import TablerTrash from "~icons/tabler/trash";
import { createSignal, For, Show } from "solid-js";
import { Link } from "../../shared/spa-link";
import { useMutation } from "../../shared/client-mutation";
import { mutateBook } from "./mutations";
import { BackLink, BookCover, Button, ConfirmDialog, Icon, LocalTime, PageIntro, ProgressBar, RelativeTime, SectionTitle, SelectPill, StarRating } from "../../ui";
import type { BookPage } from "../../server/books/service";
import { BookEditor } from "./book-editor";
import { sectionUrl } from "../reader/model";
import { languageLabel } from "./language";
import { devicePreviewHref } from "../library/search";

/** "卷三 · 坎坷记愁" → "卷三"; the section index is a spine position, not a volume number. */
export function resumeLabel(title: string | null | undefined): string | null {
  const head = (title || "").trim().split(/[\s·・:：|｜—–-]+/)[0] || "";
  return head && head.length <= 12 && !/^(位置未知|未知章节)$/.test(head) ? head : null;
}
export function bookExtent(book: BookPage["book"]): [string, string] | null {
  if (book.word_count !== null && book.word_count > 0) return ["字数", `约 ${Math.max(0.1, Math.round(book.word_count / 1000) / 10)} 万字`];
  if (book.file_size !== null && book.file_size > 0) return ["文件大小", book.file_size >= 1048576 ? `${(book.file_size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(book.file_size / 1024))} KB`];
  return null;
}
export function BookDetail(props: { page: BookPage }) {
  const [saved, setSaved] = createSignal<{ source: BookPage; value: BookPage } | null>(null);
  const page = () => saved()?.source === props.page ? saved()!.value : props.page;
  const mutation = useMutation();
  const [editing, setEditing] = createSignal(false), [deleting, setDeleting] = createSignal(false), [archiving, setArchiving] = createSignal(false);
  const [rule, setRule] = createSignal<string | null>(null);
  let deleteForm!: HTMLFormElement, archiveForm!: HTMLFormElement, regenerateForm!: HTMLFormElement, management!: HTMLDetailsElement;
  const book = () => page().book, nav = () => page().navigation;
  const latest = () => [...(page().reading_progress || [])].sort((a, b) => Date.parse(b.read_at) - Date.parse(a.read_at))[0];
  const section = () => { const value = latest()?.section; return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; };
  const readingHref = () => section() === null ? nav().preview_url : sectionUrl(book().book_id, section()!, nav().return_to, { resume: "1" });
  const readingLabel = () => {
    const label = section() !== null ? resumeLabel(latest()?.section_title) : null;
    return label ? `从${label}接着读` : latest() ? "继续阅读" : "开始阅读";
  };
  async function perform(action: "read" | "archive" | "delete" | "regenerate", form: HTMLFormElement) {
    const data = new FormData(form); data.set("book_id", book().book_id); data.set("action", action);
    await mutation.run(() => mutateBook({ data }), async result => {
      setDeleting(false); setArchiving(false);
      if (result.target) await mutation.router.navigate({ href: result.target });
      await mutation.router.invalidate();
    }, action === "read" ? "已更新阅读状态" : action === "archive" ? "已归档" : action === "delete" ? "已删除" : "已创建重建任务", action === "delete");
  }
  const specs = () => [
    ["系列", book().series], ["出版社", book().publisher], ["出版日期", book().published?.slice(0, 10)],
    ["ISBN", book().isbn], bookExtent(book()), ["标签", book().tags.join("、")], ["入库", book().created_at?.slice(0, 10)],
  ].filter((item): item is [string, string] => Boolean(item?.[1]));
  function retry() {
    management.open = true;
    regenerateForm?.scrollIntoView?.({ block: "center", behavior: "auto" });
    regenerateForm?.querySelector<HTMLSelectElement>("select")?.focus();
  }
  return <article class="books-page">
    <Show when={editing()} fallback={<>
      <PageIntro id="meta-panel" class="books-detail" variant="book" visualSize="cover" back={<BackLink href={nav().return_to}>书库</BackLink>}
        visual={<div class="books-cover"><BookCover {...book()} large eager state={book().status_class === "failed" ? "failed" : book().read ? "read" : undefined} onRetry={book().status_class === "failed" && book().can_regenerate ? retry : undefined} /></div>}
        title={book().title}
        meta={<div class="books-byline">
          <Show when={book().author}><span class="books-author">{book().author}</span></Show>
          <Show when={book().author && book().language}><span class="books-separator" aria-hidden="true">·</span></Show>
          <Show when={book().language}><span>{languageLabel(book().language!)}</span></Show>
          <Show when={book().rating !== null}><Show when={book().author || book().language}><span class="books-separator" aria-hidden="true">·</span></Show><StarRating rating={book().rating!} /></Show>
        </div>}
        description={book().description || undefined}
        status={book().status_class === "failed" || latest() ? <>
          <Show when={book().status_class === "failed"}><p role="status" class="books-failure">生成失败。<Show when={book().can_regenerate} fallback={<>请在编辑中检查书籍，重新保存并写回。</>}><Button variant="quiet-danger" onClick={retry}>检查规则并重试</Button></Show></p></Show>
          <Show when={latest()}>{item => <section class="books-progress" aria-label="阅读进度" data-reading-progress>
            <p class="books-progress-line"><span>在{item().source_label}上读到</span><strong>{item().section_title}</strong><span class="books-progress-when">{item().percent === null ? "" : `${item().percent}% · `}<RelativeTime value={item().read_at} /></span></p>
            <Show when={item().percent !== null}><ProgressBar label="全书阅读进度" value={item().percent!} /></Show>
          </section>}</Show>
        </> : undefined}
        actions={<div class="books-actions">
          <Link class="btn btn-primary btn-lg books-continue" href={readingHref()}>{readingLabel()}<Icon icon={TablerArrowUpRight} size={16} /></Link>
          <Link class="btn btn-icon btn-lg books-desktop-action" href={devicePreviewHref(book().book_id)} aria-label="设备预览" title="设备预览"><Icon icon={TablerDeviceTablet} size={20} /></Link>
          <a class="btn btn-icon btn-lg" href={`/book/${book().book_id}/download`} aria-label="下载 EPUB" title="下载 EPUB"><Icon icon={TablerDownload} size={20} /></a>
          <Link class="btn btn-icon btn-lg" href={nav().edit_url} aria-label="编辑书目信息" title="编辑" onClick={event => { if (!event.button && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); setEditing(true); } }}><Icon icon={TablerPencil} size={20} /></Link>
          <form action={`/book/${book().book_id}/read`} method="post" onSubmit={event => { event.preventDefault(); void perform("read", event.currentTarget); }}>
            <input type="hidden" name="read" value={book().read ? "0" : "1"} /><input type="hidden" name="next" value={nav().detail_url} />
            <Button type="submit" variant="secondary" size="lg" disabled={mutation.busy()}><Icon icon={book().read ? TablerX : TablerCheck} size={16} />{book().read ? "标记未读" : "标记已读"}</Button>
          </form>
        </div>} />
      <section class="books-about" aria-labelledby="books-about-title"><SectionTitle id="books-about-title">关于这本书</SectionTitle><dl class="books-spec"><For each={specs()}>{item => <div><dt>{item[0]}</dt><dd>{item[1]}</dd></div>}</For></dl></section>
      <details class="books-management" ref={management}>
        <summary>管理这本书 <span>重新生成、归档或删除</span><Icon icon={TablerChevronDown} size={16} class="ui-summary-chevron is-end" /></summary>
        <Show when={book().can_regenerate}><section class="books-management-row books-management-regenerate">
          <div><h2>重新生成</h2><p>换一条切章规则，重新切章并生成 EPUB。</p></div>
          <form ref={regenerateForm} action={`/book/${book().book_id}/regenerate`} method="post" onSubmit={event => { event.preventDefault(); void perform("regenerate", event.currentTarget); }}>
            <input type="hidden" name="next" value={nav().detail_url} />
            <SelectPill label="切章" name="rule_template" value={rule() || book().rule_template || "default"} onChange={setRule} options={page().rules.map(rule => ({ value: rule.rule_id, label: `${rule.name} · v${rule.version}` }))} />
            <Button type="submit" variant="secondary" disabled={mutation.busy()}>重新生成</Button>
          </form>
        </section></Show>
        <section class="books-management-row"><div><h2>归档</h2><p><span class="books-desktop-copy">从书库里收起来，随时可以在「已归档」里恢复。</span><span class="books-phone-copy">从书库里收起来，随时可以恢复。</span></p></div>
          <form ref={archiveForm} action={`/book/${book().book_id}/archive`} method="post" onSubmit={event => { event.preventDefault(); setArchiving(true); }}><input type="hidden" name="next" value={nav().return_to} /><Button type="submit" variant="secondary" disabled={mutation.busy()}>归档</Button></form>
        </section>
        <section class="books-management-row"><div><h2 class="books-danger">永久删除</h2><p>源文件、EPUB 和全部记录一起删掉，无法恢复。</p></div>
          <form ref={deleteForm} action={`/book/${book().book_id}/delete`} method="post" onSubmit={event => { event.preventDefault(); setDeleting(true); }}><input type="hidden" name="next" value={nav().return_to} /><Button type="submit" variant="quiet-danger" class="books-delete" aria-label={`永久删除《${book().title}》`} disabled={mutation.busy()}><Icon icon={TablerTrash} size={16} /><span class="books-delete-label">永久删除</span></Button></form>
        </section>
        <dl class="books-spec books-technical"><div><dt>来源</dt><dd>{book().source_type === "epub" ? "EPUB 直接入库" : "TXT"}</dd></div><div><dt>状态</dt><dd>{book().status_label}</dd></div><Show when={book().updated_at}><div><dt>更新时间</dt><dd><LocalTime value={book().updated_at} /></dd></div></Show></dl>
      </details>
      <ConfirmDialog open={archiving()} title="归档这本书？" confirmLabel="归档" onClose={() => setArchiving(false)} onConfirm={() => perform("archive", archiveForm)}>归档后可在书库「已归档」中恢复。</ConfirmDialog>
      <ConfirmDialog open={deleting()} title="确定要永久删除这本书吗？" danger confirmLabel="永久删除" onClose={() => { if (!mutation.busy()) setDeleting(false); }} onConfirm={() => perform("delete", deleteForm)}><p>移除源文件、EPUB 与全部记录，无法恢复。</p></ConfirmDialog>
    </>}>
      <BackLink href={nav().return_to}>书库</BackLink>
      <BookEditor page={page()} onCancel={() => setEditing(false)} onSaved={updated => { setSaved({ source: props.page, value: updated }); setEditing(false); }} />
    </Show>
  </article>;
}
