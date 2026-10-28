import { For, Show } from "solid-js";
import { BackLink, Button, Icon, PageIntro } from "../../ui";
import type { catalogPage } from "../../server/catalog/templates";
import { Editor } from "./editors";
import { Link } from "../../shared/spa-link";
import { useMutation } from "../../shared/client-mutation";
import { createTemplate, rebuildTemplate } from "./mutations";
import "./settings-templates.css";

export function RulesPage(props: { data: ReturnType<typeof catalogPage> }) {
  const mutation = useMutation();
  const themes = () => props.data.tab === "themes";
  const kind = () => themes() ? "themes" as const : "rules" as const;
  const items = () => themes() ? props.data.themes : props.data.rules;
  const usage = () => items().find(item => item.id === props.data.editor?.id);
  async function submit(event: SubmitEvent, rebuild = false) {
    event.preventDefault();
    if (rebuild && !window.confirm("将用这个模板重建所有使用它的书，并加入任务队列。继续吗？")) return;
    await mutation.run(() => rebuild ? rebuildTemplate({ data: { kind: kind(), id: themes() ? props.data.themeId : props.data.ruleId } }) : createTemplate({ data: kind() }), async result => {
      await mutation.router.navigate({ href: result.target }); await mutation.router.invalidate();
    }, rebuild ? "已创建批量重建任务" : "已新建模板");
  }
  const href = (id: string) => `/${kind()}?${themes() ? "theme_id" : "rule_id"}=${encodeURIComponent(id)}`;
  const templateMeta = (item: { id: string; version: string; book_count: number; archived_count: number }) => {
    const parts = [`v${item.version}`];
    if (item.id === "default") parts.push("内置");
    if (themes() && item.id === "default") parts.push("入库默认");
    else {
      parts.push(`${item.book_count} 本在用`);
      if (item.archived_count) parts.push(`${item.archived_count} 本已归档`);
    }
    return parts.join(" · ");
  };
  const total = () => (usage()?.book_count ?? 0) + (usage()?.archived_count ?? 0);
  return <div class="settings-templates">
    <BackLink href="/settings">设置</BackLink>
    <PageIntro eyebrow={null} title={themes() ? "主题" : "切章规则"} description={themes() ? "决定生成的 EPUB 长什么样。主题 CSS 作为最后一层追加，书自带的样式优先。" : "决定 TXT 怎么切成卷和章。入库时选一条，改了以后可以把用它的书一起重建。"} />
    <Show when={props.data.error}><p role="alert" class="notice">{props.data.error}</p></Show>
    <div class="settings-template-layout"><nav aria-label={themes() ? "主题列表" : "规则列表"}>
      <ul class="settings-template-list"><For each={items()}>{item => <li><Link aria-current={item.id === props.data.editor?.id ? "page" : undefined} href={href(item.id)}>
        <span>{item.name}</span><small>{templateMeta(item)}</small>
      </Link></li>}</For></ul>
      <form action={`/${kind()}/new`} method="post" onSubmit={event => { void submit(event); }}><Button type="submit" variant="secondary" class="settings-template-new" disabled={mutation.busy()}><Icon name="plus" size={16} />{themes() ? "新建主题" : "新建规则"}</Button></form>
    </nav><Show when={props.data.editor} keyed fallback={<p class="muted">{themes() ? "暂无主题模板。" : "暂无规则模板。"}</p>}>{editor => <Editor kind={kind()} data={editor} usage={usage()} rebuild={<form action="/books/regenerate" method="post" onSubmit={event => { void submit(event, true); }}>
      <input type="hidden" name="scope" value={props.data.tab} /><input type="hidden" name="template_id" value={editor.id} /><Button type="submit" variant="quiet" title={themes() ? `把使用这个主题的 ${total()} 本书重新生成` : `把使用这条规则的 ${total()} 本书重新切章、重新生成`} disabled={mutation.busy()}><Icon name="refresh" size={16} />重建 {total()} 本</Button>
    </form>} />}</Show></div>
  </div>;
}
