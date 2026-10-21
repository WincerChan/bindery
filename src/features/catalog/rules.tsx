import { For, Show } from "solid-js";
import { Button, PageHeader } from "../../ui";
import type { catalogPage } from "../../server/catalog/templates";
import { Editor } from "./editors";
import { Link } from "../../shared/spa-link";
import { useMutation } from "../../shared/client-mutation";
import { createTemplate, rebuildTemplate } from "./mutations";

export function RulesPage(props: { data: ReturnType<typeof catalogPage> }) {
  const mutation = useMutation();
  const themes = () => props.data.tab === "themes";
  async function submit(event: SubmitEvent, rebuild = false) {
    event.preventDefault();
    if (rebuild && !window.confirm("将用这个模板重建所有使用它的书，并加入任务队列。继续吗？")) return;
    const kind = themes() ? "themes" : "rules";
    await mutation.run(() => rebuild ? rebuildTemplate({ data: { kind, id: themes() ? props.data.themeId : props.data.ruleId } }) : createTemplate({ data: kind }), async result => {
      await mutation.router.navigate({ href: result.target }); await mutation.router.invalidate();
    }, rebuild ? "已创建批量重建任务" : "已新建模板");
  }
  const kind = () => themes() ? "themes" as const : "rules" as const;
  const href = (tab: "parsing" | "themes", id: string) => `/rules?tab=${tab}&${tab === "themes" ? "theme_id" : "rule_id"}=${encodeURIComponent(id)}`;
  return <div class="catalog-page"><PageHeader title="规则与主题" description="切章规则决定 TXT 怎么分卷分章；主题决定生成的 EPUB 怎么排版。" />
    <Show when={props.data.error}><p role="alert" class="notice">{props.data.error}</p></Show>
    <nav class="catalog-tabs" aria-label="模板类型"><Link aria-current={!themes() ? "page" : undefined} href={href("parsing", props.data.ruleId)}>切章规则</Link><Link aria-current={themes() ? "page" : undefined} href={href("themes", props.data.themeId)}>主题</Link></nav>
    <div class="catalog-layout"><aside aria-label={themes() ? "主题列表" : "规则列表"}>
      <ul class="catalog-template-list"><For each={themes() ? props.data.themes : props.data.rules}>{item => <li><Link aria-current={item.id === props.data.editor?.id ? "page" : undefined} href={href(themes() ? "themes" : "parsing", item.id)}>{item.name}<small>v{item.version}</small></Link></li>}</For></ul>
      <label class="inline-select catalog-template-select"><span>{themes() ? "主题" : "规则"}</span><select value={props.data.editor?.id} onChange={event => void mutation.router.navigate({ href: href(themes() ? "themes" : "parsing", event.currentTarget.value) })}><For each={themes() ? props.data.themes : props.data.rules}>{item => <option value={item.id}>{item.name} · v{item.version}</option>}</For></select></label>
      <form action={themes() ? "/themes/new" : "/rules/new"} method="post" onSubmit={event => { void submit(event); }}><button type="submit" class="catalog-new" disabled={mutation.busy()}>{themes() ? "+ 新建主题" : "+ 新建规则"}</button></form>
    </aside><Show when={props.data.editor} keyed fallback={<p class="muted">{themes() ? "暂无主题模板。" : "暂无规则模板。"}</p>}>{editor => <Editor kind={kind()} data={editor} rebuild={<form action="/books/regenerate" method="post" onSubmit={event => { void submit(event, true); }}>
      <input type="hidden" name="scope" value={props.data.tab} /><input type="hidden" name="template_id" value={editor.id} /><Button type="submit" variant="quiet" disabled={mutation.busy()}>{themes() ? "重建使用此主题的书" : "重建使用此规则的书"}</Button>
    </form>} />}</Show></div>
  </div>;
}
