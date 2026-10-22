import { createSignal, For, Show } from "solid-js";
import { Link } from "../../shared/spa-link";
import { useMutation } from "../../shared/client-mutation";
import { mutateBook } from "./mutations";
import { BookCover, Button, ConfirmDialog, Select } from "../../ui";
import type { BookPage } from "../../server/books/service";
import { BookEditor } from "./book-editor";

export function durationLabel(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return "不到 1 分钟";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `约 ${Math.max(1, minutes)} 分钟`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `约 ${hours} 小时`;
  return `约 ${Math.ceil(hours / 24)} 天`;
}
const progressTime = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? value.slice(0, 16).replace("T", " ") : value;
};

export function BookDetail(props: { page: BookPage }) {
  const [saved, setSaved] = createSignal<{ source: BookPage; value: BookPage } | null>(null);
  const page = () => saved()?.source === props.page ? saved()!.value : props.page;
  const mutation = useMutation();
  const [editing, setEditing] = createSignal(false),
    [deleting, setDeleting] = createSignal(false);
  let deleteForm!: HTMLFormElement;
  async function perform(action: "read" | "archive" | "delete" | "regenerate", form: HTMLFormElement) {
    const data = new FormData(form); data.set("book_id", book().book_id); data.set("action", action);
    await mutation.run(() => mutateBook({ data }), async result => {
      setDeleting(false);
      if (result.target) await mutation.router.navigate({ href: result.target });
      await mutation.router.invalidate();
    }, action === "read" ? "已更新阅读状态" : action === "archive" ? "已归档" : action === "delete" ? "已删除" : "已创建重建任务", action === "delete");
  }
  const book = () => page().book,
    nav = () => page().navigation;
  const specs = () => [
    ["系列", book().series],
    ["出版社", book().publisher],
    ["出版日期", book().published?.slice(0, 10)],
    ["ISBN", book().isbn],
    ["标签", book().tags.join("、")],
    ["来源", book().source_type === "epub" ? "EPUB 直接入库" : "TXT"],
    ["规则模板", book().rule_template],
    ["状态", book().status_label],
  ];
  return (
    <article class="books-page">
      <nav class="books-breadcrumb" aria-label="路径">
        <Link href={nav().return_to}>书库</Link>
        <span aria-hidden="true">/</span>
        <span>{book().title}</span>
      </nav>
      <Show
        when={editing()}
        fallback={
          <>
            <div id="meta-panel" class="books-detail">
              <div class="books-cover">
                <BookCover
                  book_id={book().book_id}
                  title={book().title}
                  author={book().author}
                  cover_url={book().cover_url}
                  eager
                />
                <small>
                  {book().source_type.toUpperCase()} · 更新{" "}
                  {book().updated_at.slice(0, 10)}
                </small>
              </div>
              <header class="books-heading">
                <span class="books-eyebrow">书目</span>
                <h1>{book().title}</h1>
                <Show when={book().series}>
                  <p>{book().series}</p>
                </Show>
                <div class="books-byline">
                  <span>{book().author || "未知"}</span>
                  <span>{book().language}</span>
                  <span aria-label={`评分 ${book().rating ?? "未评分"}`}>
                    {book().rating === null
                      ? "未评分"
                      : `${"★".repeat(book().rating!)}${"☆".repeat(5 - book().rating!)}`}
                  </span>
                  <span aria-label="阅读状态">
                    {book().read ? "✓ 已读" : "未读"}
                  </span>
                </div>
              </header>
              <div class="books-actions">
                <Link class="btn btn-primary" href={nav().preview_url}>
                  阅读
                </Link>
                <a
                  class="btn btn-secondary"
                  href={`/book/${book().book_id}/download`}
                >
                  下载 EPUB
                </a>
                <form action={`/book/${book().book_id}/read`} method="post" onSubmit={event => { event.preventDefault(); void perform("read", event.currentTarget); }}>
                  <input
                    type="hidden"
                    name="read"
                    value={book().read ? "0" : "1"}
                  />
                  <input type="hidden" name="next" value={nav().detail_url} />
                  <Button type="submit" variant="secondary" disabled={mutation.busy()}>
                    {book().read ? "标记未读" : "标记已读"}
                  </Button>
                </form>
                <Link
                  class="btn btn-secondary"
                  href={nav().edit_url}
                  onClick={(event) => {
                    if (!event.button && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
                      event.preventDefault(); setEditing(true);
                    }
                  }}
                >
                  编辑
                </Link>
                <form action={`/book/${book().book_id}/archive`} method="post" onSubmit={event => { event.preventDefault(); void perform("archive", event.currentTarget); }}>
                  <input type="hidden" name="next" value={nav().return_to} />
                  <Button type="submit" variant="quiet" disabled={mutation.busy()}>
                    归档
                  </Button>
                </form>
              </div>
              <div class="books-body">
                <dl class="books-spec">
                  <For each={specs()}>
                    {(item) => (
                      <div>
                        <dt>{item[0]}</dt>
                        <dd>{item[1] || "—"}</dd>
                      </div>
                    )}
                  </For>
                  <For
                    each={[
                      ["入库时间", book().created_at],
                      ["更新时间", book().updated_at],
                    ]}
                  >
                    {(item) => (
                      <Show when={item[1]}>
                        <div>
                          <dt>{item[0]}</dt>
                          <dd>
                            <time
                              datetime={item[1]}
                              title={item[1].slice(0, 19).replace("T", " ")}
                            >
                              {item[1].slice(0, 16).replace("T", " ")}
                            </time>
                          </dd>
                        </div>
                      </Show>
                    )}
                  </For>
                </dl>
                <Show when={page().reading_progress?.length}>
                  <section class="books-progress" aria-labelledby="reading-progress-heading">
                    <h2 id="reading-progress-heading">阅读进度</h2>
                    <ul><For each={page().reading_progress}>{item => <li data-reading-progress>
                      <div class="books-progress-head"><strong>{item.source_label}</strong><Show when={item.latest}><span class="books-progress-latest">最新</span></Show></div>
                      <p class="books-progress-position">{item.section_title}{item.percent === null ? "" : ` · ${item.percent}%`}</p>
                      <p class="books-progress-meta">上次阅读 {progressTime(item.read_at)}{durationLabel(item.time_spent_seconds) ? ` · 用时 ${durationLabel(item.time_spent_seconds)}` : ""}{durationLabel(item.rest_estimate_seconds) ? ` · 剩余 ${durationLabel(item.rest_estimate_seconds)}` : ""}</p>
                    </li>}</For></ul>
                  </section>
                </Show>
                <Show when={book().description}>
                  <section class="books-description">
                    <h2>简介</h2>
                    <p>{book().description}</p>
                  </section>
                </Show>
              </div>
            </div>
            <div class="books-bottom">
              <Show when={book().can_regenerate}>
                <section>
                  <h2>重新生成</h2>
                  <p>切换规则模板重新切章与生成 EPUB。</p>
                  <form
                    class="books-actions"
                    action={`/book/${book().book_id}/regenerate`}
                    method="post"
                    onSubmit={event => { event.preventDefault(); void perform("regenerate", event.currentTarget); }}
                  >
                    <input type="hidden" name="next" value={nav().detail_url} />
                    <Select
                      label="规则模板"
                      name="rule_template"
                      value={book().rule_template || "default"}
                    >
                      <For each={page().rules}>
                        {(rule) => (
                          <option value={rule.rule_id}>
                            {rule.name} · v{rule.version}
                          </option>
                        )}
                      </For>
                    </Select>
                    <Button type="submit" variant="secondary" disabled={mutation.busy()}>
                      重新生成 EPUB
                    </Button>
                  </form>
                </section>
              </Show>
              <section>
                <h2>永久删除</h2>
                <p>移除源文件、EPUB 与全部记录，无法恢复。</p>
                <form
                  ref={deleteForm}
                  action={`/book/${book().book_id}/delete`}
                  method="post"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setDeleting(true);
                  }}
                >
                  <input type="hidden" name="next" value={nav().return_to} />
                  <Button type="submit" variant="danger" disabled={mutation.busy()}>
                    永久删除
                  </Button>
                </form>
              </section>
            </div>
            <ConfirmDialog
              open={deleting()}
              title="确定要永久删除这本书吗？"
              danger
              confirmLabel="永久删除"
              onClose={() => { if (!mutation.busy()) setDeleting(false); }}
              onConfirm={() => perform("delete", deleteForm)}
            >
              <p>移除源文件、EPUB 与全部记录，无法恢复。</p>
            </ConfirmDialog>
          </>
        }
      >
        <BookEditor
          page={page()}
          onCancel={() => setEditing(false)}
          onSaved={updated => { setSaved({ source: props.page, value: updated }); setEditing(false); }}
        />
      </Show>
    </article>
  );
}
