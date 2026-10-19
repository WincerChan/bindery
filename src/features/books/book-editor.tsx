import { createSignal, For, Show } from "solid-js";
import {
  BookCover,
  Button,
  Checkbox,
  Select,
  Textarea,
  TextField,
} from "../../ui";
import { showToast } from "../../client/toast";
import type { BookPage } from "../../server/books/service";
import { formatCssText } from "./css";

export function BookEditor(props: {
  page: BookPage;
  onCancel?: () => void;
  onSaved?: (page: BookPage) => void;
}) {
  const [page, setPage] = createSignal(props.page),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(props.page.error || ""),
    [rating, setRating] = createSignal<number | null>(props.page.book.rating);
  let form!: HTMLFormElement, css!: HTMLTextAreaElement;
  const book = () => page().book,
    id = () => book().book_id;
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    const button = event.submitter as HTMLButtonElement | null,
      lookup = button?.value === "lookup";
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/book/${id()}/${lookup ? "metadata/fetch" : "edit"}`,
        {
          method: "POST",
          body: new FormData(form),
          headers: { Accept: "application/json" },
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "操作失败，请重试");
      if (data.page) {
        setPage(data.page);
        setRating(data.page.book.rating);
        setError(data.page.error || "");
      }
      if (data.message) showToast(data.message, data.kind);
      if (!lookup && data.target) {
        if (props.onSaved) props.onSaved(data.page);
        else location.assign(data.target);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "操作失败，请重试";
      setError(message);
      showToast(message, "error");
    } finally {
      setBusy(false);
    }
  }
  const changed = (key: string) =>
    page().lookup_changed_fields?.includes(key) ? "books-autofill" : "";
  return (
    <div class="books-page books-editor" id="meta-panel">
      <form
        ref={form}
        action={`/book/${id()}/edit`}
        method="post"
        enctype="multipart/form-data"
        onSubmit={submit}
        aria-busy={busy() ? "true" : "false"}
      >
        <input
          type="hidden"
          name="return_to"
          value={page().navigation.return_to}
        />
        <input
          type="hidden"
          name="metadata_source"
          value={page().lookup_selected_source || ""}
        />
        <header class="books-edit-heading">
          <h1>{book().title}</h1>
          <div class="books-actions">
            <a
              class="btn btn-secondary"
              href={page().navigation.detail_url}
              onClick={(event) => {
                if (props.onCancel) {
                  event.preventDefault();
                  props.onCancel();
                }
              }}
            >
              取消
            </a>
            <Button type="submit" disabled={busy()}>
              保存并写回
            </Button>
          </div>
        </header>
        <Show when={error()}>
          <p role="alert" class="field-error books-notice">
            {error()}
          </p>
        </Show>
        <Show when={page().info}>
          <p role="status" class="books-notice">
            {page().info}
          </p>
        </Show>
        <div class="books-edit-top">
          <div class="books-cover">
            <BookCover
              book_id={id()}
              title={book().title}
              author={book().author}
              cover_url={book().cover_url}
              eager
            />
          </div>
          <div class="books-fields">
            <TextField
              label="书名"
              name="title"
              value={book().title}
              class={changed("title")}
              required
            />
            <TextField
              label="作者"
              name="author"
              value={book().author || ""}
              class={changed("author")}
            />
            <TextField
              label="语言"
              name="language"
              value={book().language}
              class={changed("language")}
            />
            <TextField label="系列" name="series" value={book().series || ""} />
            <fieldset class="books-rating">
              <legend>评分</legend>
              <input type="hidden" name="rating" value={rating() ?? ""} />
              <For each={[1, 2, 3, 4, 5]}>
                {(star) => (
                  <Button
                    variant="quiet"
                    aria-label={`${star} 星`}
                    aria-pressed={rating() === star ? "true" : "false"}
                    onClick={() => setRating(star)}
                  >
                    {star <= (rating() || 0) ? "★" : "☆"}
                  </Button>
                )}
              </For>
              <Button variant="quiet" onClick={() => setRating(null)}>
                清除
              </Button>
              <output>{rating() === null ? "未评分" : `${rating()} 星`}</output>
            </fieldset>
            <div class="books-lookup">
              <Button
                type="submit"
                name="intent"
                value="lookup"
                formaction={`/book/${id()}/metadata/fetch`}
                formnovalidate
                disabled={busy()}
                variant="secondary"
              >
                {busy() ? "请求中..." : "自动填充信息"}
              </Button>
              <span role="status">
                {busy() ? "正在请求豆瓣，请稍候…" : "按书名和作者检索豆瓣"}
              </span>
            </div>
            <TextField
              label="出版社"
              name="publisher"
              value={book().publisher || ""}
              class={changed("publisher")}
            />
            <TextField
              label="标签（逗号分隔）"
              name="tags"
              value={book().tags.join(", ")}
              class={changed("tags")}
            />
            <TextField
              label="发表时间"
              name="published"
              value={book().published?.slice(0, 10) || ""}
              class={changed("published")}
            />
            <TextField
              label="ISBN"
              name="isbn"
              value={book().isbn || ""}
              class={changed("isbn")}
            />
            <TextField
              label="封面（本地上传）"
              type="file"
              name="cover_file"
              accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
              hint="可选：与 URL 二选一；上传后会写入 EPUB 本体。"
            />
            <TextField
              label="封面（URL 下载）"
              type="url"
              name="cover_url"
              value={book().cover_fetch_url || ""}
              class={changed("cover_url")}
              placeholder="https://example.com/cover.jpg"
              hint="可选：保存时会下载并写回到 EPUB。"
            />
            <Textarea
              label="内容简介"
              name="description"
              value={book().description || ""}
              rows={6}
              class={`books-wide ${changed("description")}`}
            />
          </div>
        </div>
        <section class="books-build">
          <h2>构建设置</h2>
          <p>解析规则影响重新生成；渲染主题与自定义 CSS 会写回到 EPUB。</p>
          <div class="books-fields">
            <Show
              when={book().can_regenerate}
              fallback={
                <input
                  type="hidden"
                  name="rule_template"
                  value={book().rule_template || ""}
                />
              }
            >
              <Select
                label="切章规则（仅 TXT）"
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
            </Show>
            <Select
              label="渲染主题"
              name="theme_template"
              value={book().effective_theme_template || "__book__"}
              hint="会作为最后一层 CSS 追加（用于字体/边距等统一化）。"
            >
              <option value="__book__">保持书籍样式（仅 EPUB）</option>
              <For each={page().themes}>
                {(theme) => (
                  <option value={theme.theme_id}>
                    {theme.name} · v{theme.version}
                  </option>
                )}
              </For>
            </Select>
            <div class="books-wide">
              <Checkbox
                label="清除原书 CSS（link/style）"
                name="strip_original_css"
                value="1"
                checked={page().strip_original_css}
              />
              <p>
                仅本次写回生效：会移除 EPUB 原有样式表链接、内联 &lt;style&gt;
                和 CSS 资源文件，再按“渲染主题 + 本书追加 CSS”重新注入。
              </p>
            </div>
            <div class="books-wide">
              <div class="books-actions">
                <h3>高级：针对本书追加 CSS</h3>
                <Button
                  size="sm"
                  variant="quiet"
                  data-format-target="book-custom-css"
                  onClick={() => {
                    css.value = formatCssText(css.value);
                  }}
                >
                  格式化
                </Button>
              </div>
              <Textarea
                ref={css}
                id="book-custom-css"
                label="本书追加 CSS"
                name="custom_css"
                rows={8}
                value={book().custom_css || ""}
                hint="这段 CSS 会追加在主题之后，优先生效。"
              />
            </div>
          </div>
        </section>
        <Show when={page().lookup_result}>
          {(result) => (
            <section class="books-lookup-result" aria-label="检索结果">
              <h2>豆瓣（已应用）</h2>
              <dl class="books-spec">
                <div>
                  <dt>书名</dt>
                  <dd>{result().title}</dd>
                </div>
                <div>
                  <dt>来源封面 URL</dt>
                  <dd>{result().cover_url || "—"}</dd>
                </div>
                <div>
                  <dt>已应用封面 URL</dt>
                  <dd>{result().applied_cover_url || "—"}</dd>
                </div>
              </dl>
            </section>
          )}
        </Show>
        <Show when={page().lookup_attempts?.length}>
          <details>
            <summary>检索详情</summary>
            <For each={page().lookup_attempts}>
              {(attempt) => (
                <p>
                  {attempt.source === "douban" ? "豆瓣" : attempt.source}：
                  {attempt.ok
                    ? `${attempt.title}（${attempt.score}）`
                    : attempt.error}
                </p>
              )}
            </For>
          </details>
        </Show>
      </form>
      <section class="books-cover-tools">
        <h2>封面</h2>
        <div class="books-fields">
          <form
            action={`/book/${id()}/cover/upload`}
            method="post"
            enctype="multipart/form-data"
          >
            <TextField
              label="上传封面"
              name="cover"
              type="file"
              accept="image/*"
              required
            />
            <Button type="submit" variant="secondary">
              上传封面
            </Button>
          </form>
          <form action={`/book/${id()}/cover/url`} method="post">
            <TextField label="封面 URL" name="cover_url" type="url" required />
            <Button type="submit" variant="secondary">
              下载封面
            </Button>
          </form>
          <form action={`/book/${id()}/cover/extract`} method="post">
            <Button type="submit" variant="secondary">
              从 EPUB 提取封面
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
