import { createSignal, For, Show, untrack } from "solid-js";
import { BookCover, Button, ConfirmDialog, Select } from "../../ui";
import type { BookPage } from "../../server/books/service";
import { BookEditor } from "./book-editor";

export function BookDetail(props: { page: BookPage }) {
  const [page, setPage] = createSignal(untrack(() => props.page)),
    [editing, setEditing] = createSignal(false),
    [deleting, setDeleting] = createSignal(false);
  let deleteForm!: HTMLFormElement;
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
        <a href={nav().return_to}>书库</a>
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
                <a class="btn btn-primary" href={nav().preview_url}>
                  阅读
                </a>
                <a
                  class="btn btn-secondary"
                  href={`/book/${book().book_id}/download`}
                >
                  下载 EPUB
                </a>
                <form action={`/book/${book().book_id}/read`} method="post">
                  <input
                    type="hidden"
                    name="read"
                    value={book().read ? "0" : "1"}
                  />
                  <input type="hidden" name="next" value={nav().detail_url} />
                  <Button type="submit" variant="secondary">
                    {book().read ? "标记未读" : "标记已读"}
                  </Button>
                </form>
                <a
                  class="btn btn-secondary"
                  href={nav().edit_url}
                  onClick={(event) => {
                    event.preventDefault();
                    setEditing(true);
                  }}
                >
                  编辑
                </a>
                <form action={`/book/${book().book_id}/archive`} method="post">
                  <input type="hidden" name="next" value={nav().return_to} />
                  <Button type="submit" variant="quiet">
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
                    <Button type="submit" variant="secondary">
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
                  <Button type="submit" variant="danger">
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
              onClose={() => setDeleting(false)}
              onConfirm={() => deleteForm.submit()}
            >
              <p>移除源文件、EPUB 与全部记录，无法恢复。</p>
            </ConfirmDialog>
          </>
        }
      >
        <BookEditor
          page={page()}
          onCancel={() => setEditing(false)}
          onSaved={(updated) => {
            setPage(updated);
            setEditing(false);
          }}
        />
      </Show>
    </article>
  );
}
