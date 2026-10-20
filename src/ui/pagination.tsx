import { Link } from "../shared/spa-link";
import { For, Show } from "solid-js";
export function paginationItems(page: number, pages: number): (number | "gap")[] {
  const total = Math.max(1, Math.trunc(pages)), current = Math.max(1, Math.min(total, Math.trunc(page)));
  const visible = Array.from(new Set([1, total, current - 1, current, current + 1])).filter(n => n >= 1 && n <= total).sort((a, b) => a - b);
  const result: (number | "gap")[] = [];
  visible.forEach((n, i) => { if (i && n - visible[i - 1]! > 1) result.push("gap"); result.push(n); });
  return result;
}
export function pageHref(href: string, page: number, pageParam = "page"): string {
  const url = new URL(href, "http://bindery.local");
  url.searchParams.set(pageParam, String(page));
  return `${url.pathname}${url.search}${url.hash}`;
}
export function Pagination(props: { page: number; total: number; perPage: number; href: string; pageParam?: string; replace?: boolean; resetScroll?: boolean; hashScrollIntoView?: boolean }) {
  const pages = () => Math.max(1, Math.ceil(props.total / Math.max(1, props.perPage)));
  const current = () => Math.max(1, Math.min(pages(), props.page));
  return <Show when={pages() > 1}><nav class="pagination" aria-label="分页">
    <Show when={current() > 1} fallback={<span aria-disabled="true">上一页</span>}><Link replace={props.replace} resetScroll={props.resetScroll} hashScrollIntoView={props.hashScrollIntoView} href={pageHref(props.href, current() - 1, props.pageParam)}>上一页</Link></Show>
    <For each={paginationItems(current(), pages())}>{item => item === "gap" ? <span aria-hidden="true">…</span> : <Link replace={props.replace} resetScroll={props.resetScroll} hashScrollIntoView={props.hashScrollIntoView} href={pageHref(props.href, item, props.pageParam)} aria-label={`第 ${item} 页`} aria-current={item === current() ? "page" : undefined}>{item}</Link>}</For>
    <Show when={current() < pages()} fallback={<span aria-disabled="true">下一页</span>}><Link replace={props.replace} resetScroll={props.resetScroll} hashScrollIntoView={props.hashScrollIntoView} href={pageHref(props.href, current() + 1, props.pageParam)}>下一页</Link></Show>
  </nav></Show>;
}
