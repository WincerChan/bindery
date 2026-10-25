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

type PaginationProps = {
  page: number;
  total: number;
  perPage: number;
  shown?: number;
  unit?: string;
  label?: string;
  href?: string;
  onPage?: (page: number) => void;
  pageParam?: string;
  replace?: boolean;
  resetScroll?: boolean;
  hashScrollIntoView?: boolean;
};

function PageControl(props: Pick<PaginationProps, "href" | "onPage" | "pageParam" | "replace" | "resetScroll" | "hashScrollIntoView"> & { page: number; label?: string; children: string | number }) {
  return <Show when={props.onPage} fallback={<Link class="pagination-control" replace={props.replace} resetScroll={props.resetScroll} hashScrollIntoView={props.hashScrollIntoView} href={pageHref(props.href ?? "/", props.page, props.pageParam)} aria-label={props.label}>{props.children}</Link>}>
    {onPage => <button class="pagination-control" type="button" aria-label={props.label} onClick={() => onPage()(props.page)}>{props.children}</button>}
  </Show>;
}

/** Shared result summary and page controls for link-based and in-place lists. */
export function Pagination(props: PaginationProps) {
  const pageSize = () => Math.max(1, props.perPage), total = () => Math.max(0, props.total);
  const pages = () => Math.max(1, Math.ceil(total() / pageSize()));
  const current = () => Math.max(1, Math.min(pages(), props.page));
  const shown = () => Math.max(0, props.shown ?? Math.min(pageSize(), total() - (current() - 1) * pageSize()));
  const start = () => shown() ? (current() - 1) * pageSize() + 1 : 0;
  const end = () => shown() ? start() + shown() - 1 : 0;
  return <nav class="pagination" aria-label={props.label ?? "分页"}>
    <span class="pagination-summary">{shown() ? `${start()}–${end()}` : "0"} / 共 <span data-pagination-total>{total()}</span> {props.unit ?? "条"}</span>
    <Show when={pages() > 1}><div class="pagination-controls">
      <Show when={current() > 1} fallback={<span class="pagination-control" aria-disabled="true">上一页</span>}><PageControl {...props} page={current() - 1}>上一页</PageControl></Show>
      <div class="pagination-pages"><For each={paginationItems(current(), pages())}>{item => item === "gap"
        ? <span class="pagination-gap" aria-hidden="true">…</span>
        : <Show when={item !== current()} fallback={<span class="pagination-control" aria-current="page" aria-label={`第 ${item} 页，当前页`}>{item}</span>}><PageControl {...props} page={item} label={`第 ${item} 页`}>{item}</PageControl></Show>}</For></div>
      <Show when={current() < pages()} fallback={<span class="pagination-control" aria-disabled="true">下一页</span>}><PageControl {...props} page={current() + 1}>下一页</PageControl></Show>
    </div></Show>
  </nav>;
}
