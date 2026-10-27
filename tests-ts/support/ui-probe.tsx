import { renderToString } from "@solidjs/web";
import { Button, TextField, Select, Textarea, Checkbox, Chip, Tag, BookCover, GeneratedCover, Dialog, ConfirmDialog, EmptyState, Pagination } from "../../src/ui";
import { SettingsHub } from "../../src/features/settings/hub";
import type { SettingsSummary } from "../../src/server/settings/summary";
export function settings(summary: SettingsSummary) { return renderToString(() => <SettingsHub summary={summary} now={Date.parse("2026-10-26T12:00:00Z")} />); }
export { coverTone } from "../../src/ui/cover";
export { paginationItems, pageHref } from "../../src/ui/pagination";

export function controls() {
  return renderToString(() => <>
    <Button>保存</Button><Button type="submit" variant="secondary" size="sm" disabled>取消</Button><Button variant="quiet">阅读</Button><Button variant="danger">删除</Button>
    <TextField name="title" label="书名" value="乱世书" required hint="请输入书名" />
    <TextField id="author" label="作者" error="作者不能为空" aria-describedby="external-help" />
    <Select label="排序" name="sort"><option value="updated">最近更新</option></Select>
    <Textarea label="简介" name="description" rows={4} />
    <Checkbox label="已读" name="read" checked />
    <Checkbox label="全选" indeterminate />
    <Chip selected>未读</Chip><Chip>全部</Chip><Tag tone="failed">转换失败</Tag>
  </>);
}
export function kindleControls() {
  return renderToString(() => <>
    <Button variant="quiet-danger">删除所选</Button><Button variant="icon" aria-label="预览书籍"><svg aria-hidden="true" /></Button>
    <Chip variant="filter" selected>全部</Chip><Chip variant="filter">其他</Chip>
    <TextField label="搜索设备上的书" labelHidden type="search" />
  </>);
}
export function covers() {
  return renderToString(() => <>
    <GeneratedCover book_id="ff" title="春日<&>" author="作者" />
    <GeneratedCover book_id="03" title="🌿春" compact />
    <BookCover book_id="01" title="有封面" cover_url="/book/1/cover?v=2" />
    <BookCover book_id="02" title="无封面" />
  </>);
}
export function dialogs() {
  return renderToString(() => <>
    <Dialog open={false} title="更多" onClose={() => {}}><a href="/rules">规则与主题</a></Dialog>
    <ConfirmDialog open={false} title="删除书籍" danger onClose={() => {}} onConfirm={() => {}}>确定删除？</ConfirmDialog>
  </>);
}
export function pagination(page: number, total: number) {
  return renderToString(() => <Pagination page={page} total={total} perPage={10} href="/?q=书&view=list#books" />);
}
export function empty() {
  return renderToString(() => <EmptyState action={<a href="/ingest">入库</a>}>还没有书籍。</EmptyState>);
}
