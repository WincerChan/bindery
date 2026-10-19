import { For, Show } from "solid-js";
import { Button } from "../../ui";
import type { catalogPage } from "../../server/catalog/templates";
import { Editor } from "./editors";

export function RulesPage(props: { data: ReturnType<typeof catalogPage> }) {
  const themes = () => props.data.tab === "themes";
  return <div class="catalog-page"><div class="catalog-heading"><h1>规则与主题</h1><p class="muted">{props.data.rules.length} 规则 / {props.data.themes.length} 主题</p></div>
    <Show when={props.data.error}><p role="alert" class="notice">{props.data.error}</p></Show>
    <nav class="catalog-actions" aria-label="模板类型"><a class="btn btn-secondary" aria-current={!themes() ? "page" : undefined} href={`/rules?tab=parsing&rule_id=${encodeURIComponent(props.data.ruleId)}`}>结构</a><a class="btn btn-secondary" aria-current={themes() ? "page" : undefined} href={`/rules?tab=themes&theme_id=${encodeURIComponent(props.data.themeId)}`}>样式</a></nav>
    <div class="catalog-layout"><aside aria-label={themes() ? "输出主题" : "切章规则"}><h2>{themes() ? "输出主题" : "切章规则"}</h2>
      <ul class="catalog-template-list"><For each={themes() ? props.data.themes : props.data.rules}>{item => <li><a aria-current={item.id === props.data.editor?.id ? "page" : undefined} href={`/rules?tab=${themes() ? "themes" : "parsing"}&${themes() ? "theme_id" : "rule_id"}=${encodeURIComponent(item.id)}`}>{item.name}<small>v{item.version}</small></a></li>}</For></ul>
      <form action={themes() ? "/themes/new" : "/rules/new"} method="post"><Button type="submit">{themes() ? "+ 新增样式" : "+ 新增规则"}</Button></form>
      <form action="/books/regenerate" method="post" onSubmit={event => { if (!window.confirm("将按当前模板批量重建匹配书籍并进入任务队列，继续吗？")) event.preventDefault(); }}>
        <input type="hidden" name="scope" value={props.data.tab} /><input type="hidden" name="template_id" value={themes() ? props.data.themeId : props.data.ruleId} /><Button type="submit" variant="secondary">一键批量重建（当前模板）</Button>
      </form>
    </aside><Show when={props.data.editor} keyed fallback={<p class="muted">{themes() ? "暂无主题模板。" : "暂无规则模板。"}</p>}>{editor => <Editor kind={themes() ? "themes" : "rules"} data={editor} />}</Show></div>
  </div>;
}
