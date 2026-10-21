import { For } from "solid-js";
import type { JSX } from "@solidjs/web";

/** Placeholder block shown while a route loads. Decorative: the region is announced once via aria-busy. */
export function Bone(props: { width?: string; height?: string; class?: string; style?: JSX.CSSProperties }) {
  return <span class={`skeleton-bone ${props.class || ""}`} style={{ width: props.width, height: props.height, ...props.style }} />;
}
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

function Region(props: { label: string; class?: string; children: JSX.Element }) {
  return <div class={`skeleton ${props.class || ""}`} role="status" aria-busy="true" aria-label={props.label}>{props.children}</div>;
}
function Header(props: { actions?: number }) {
  return <div class="skeleton-header"><div><Bone width="180px" height="38px" /><Bone width="320px" height="16px" style={{ "margin-top": "12px" }} /></div>
    <div class="skeleton-row">{range(props.actions ?? 1).map(() => <Bone width="96px" height="40px" />)}</div></div>;
}
function Tabs(props: { count?: number }) {
  return <div class="skeleton-tabs">{range(props.count ?? 2).map(() => <Bone width="64px" height="18px" />)}</div>;
}
function Lines(props: { count: number }) {
  return <div class="skeleton-lines"><For each={range(props.count)}>{index => <Bone width={index === props.count - 1 ? "60%" : "100%"} height="14px" />}</For></div>;
}
function TableRows(props: { rows: number }) {
  return <div class="skeleton-table"><Bone width="100%" height="12px" class="skeleton-table-head" /><For each={range(props.rows)}>{() => <div class="skeleton-table-row"><Bone width="32%" height="16px" /><Bone width="18%" height="14px" /><Bone width="12%" height="14px" /><Bone width="10%" height="14px" /></div>}</For></div>;
}

export function PageSkeleton() {
  return <Region label="页面加载中"><Header /><Lines count={6} /></Region>;
}
export function LibrarySkeleton() {
  return <Region label="书库加载中"><Header /><Tabs /><div class="skeleton-row skeleton-toolbar"><Bone width="420px" height="40px" /><Bone width="88px" height="20px" /></div>
    <div class="skeleton-covers"><For each={range(14)}>{() => <div><Bone class="skeleton-cover" /><Bone width="80%" height="14px" style={{ "margin-top": "10px" }} /><Bone width="50%" height="12px" style={{ "margin-top": "6px" }} /></div>}</For></div>
    <div class="skeleton-list"><For each={range(6)}>{() => <div class="skeleton-list-row"><Bone class="skeleton-thumb" /><div class="skeleton-lines"><Bone width="70%" height="16px" /><Bone width="40%" height="12px" /></div></div>}</For></div></Region>;
}
export function TableSkeleton() {
  return <Region label="列表加载中"><Header actions={2} /><div class="skeleton-row skeleton-toolbar"><Bone width="100%" height="40px" /></div><TableRows rows={8} /></Region>;
}
export function IngestSkeleton() {
  return <Region label="入库页加载中"><Header /><div class="skeleton-split"><Bone width="100%" height="300px" /><div class="skeleton-lines"><Bone width="40%" height="20px" /><Bone width="100%" height="40px" /><Bone width="100%" height="40px" /><Bone width="100%" height="44px" style={{ "margin-top": "24px" }} /></div></div></Region>;
}
export function EditorSkeleton() {
  return <Region label="编辑器加载中"><Header /><Tabs /><div class="skeleton-sidebar"><div class="skeleton-lines"><Bone width="100%" height="36px" /><Bone width="100%" height="36px" /></div><div class="skeleton-split"><Bone width="100%" height="520px" /><Bone width="100%" height="520px" /></div></div></Region>;
}
export function BookSkeleton() {
  return <Region label="书籍加载中"><div class="skeleton-book"><Bone class="skeleton-cover" /><div class="skeleton-lines"><Bone width="60%" height="36px" /><Bone width="30%" height="18px" /><div style={{ "margin-top": "16px" }}><Lines count={5} /></div></div></div></Region>;
}
/** Whole device area on first entry: device bar, tabs and the books table. */
export function DeviceSkeleton() {
  return <Region label="设备加载中"><Header actions={2} /><Tabs count={4} /><div class="skeleton-row skeleton-toolbar"><Bone width="320px" height="40px" /><Bone width="120px" height="40px" /></div><TableRows rows={6} /></Region>;
}
/** Device sub-pages render under the persistent device bar and tabs, so only the body is a skeleton. */
export function DeviceBodySkeleton() {
  return <Region label="设备内容加载中" class="skeleton-body"><div class="skeleton-row skeleton-toolbar"><Bone width="320px" height="40px" /><Bone width="120px" height="40px" /></div><TableRows rows={6} /></Region>;
}
export function ReaderSkeleton() {
  return <Region label="正文加载中" class="skeleton-reader"><div class="skeleton-reader-page"><Bone width="45%" height="24px" /><Lines count={14} /></div></Region>;
}
