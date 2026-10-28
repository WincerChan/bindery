import TablerArrowLeft from "~icons/tabler/arrow-left";
import TablerArrowRight from "~icons/tabler/arrow-right";
import { Link } from "../shared/spa-link";
import { Show } from "solid-js";
import { Icon, type IconComponent } from "./icon";

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

export type PaginationProps = {
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

function PageControl(props: Pick<PaginationProps, "href" | "onPage" | "pageParam" | "replace" | "resetScroll" | "hashScrollIntoView"> & { page: number; label?: string; icon: IconComponent }) {
  return <Show when={props.onPage} fallback={<Link class="pagination-control" replace={props.replace} resetScroll={props.resetScroll} hashScrollIntoView={props.hashScrollIntoView} href={pageHref(props.href ?? "/", props.page, props.pageParam)} aria-label={props.label}><Icon icon={props.icon} size={18} /></Link>}>
    {onPage => <button class="pagination-control" type="button" aria-label={props.label} onClick={() => onPage()(props.page)}><Icon icon={props.icon} size={18} /></button>}
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
  const padded = (value: number) => String(value).padStart(2, "0");
  return <nav class="pagination" aria-label={props.label ?? "分页"}>
    <span class="pagination-summary"><strong>{shown() ? `${start()}–${end()}` : "0"}</strong> {props.unit ?? "条"} · 共 <span data-pagination-total>{total()}</span> {props.unit ?? "条"}</span>
    <div class="pagination-controls">
      <span class="pagination-pages"><span class="pagination-page-number" aria-current="page" aria-label={`第 ${current()} 页，当前页`}>{padded(current())}</span><span class="pagination-page-total">/ {padded(pages())} 页<span class="pagination-phone-total"> · 共 {total()} {props.unit ?? "条"}</span></span></span>
      <Show when={current() > 1} fallback={<span class="pagination-control" aria-disabled="true" aria-label="上一页"><Icon icon={TablerArrowLeft} size={18} /></span>}><PageControl {...props} page={current() - 1} label="上一页" icon={TablerArrowLeft} /></Show>
      <Show when={current() < pages()} fallback={<span class="pagination-control" aria-disabled="true" aria-label="下一页"><Icon icon={TablerArrowRight} size={18} /></span>}><PageControl {...props} page={current() + 1} label="下一页" icon={TablerArrowRight} /></Show>
    </div>
  </nav>;
}
