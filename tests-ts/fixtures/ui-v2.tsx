import { render, renderToString } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { AddCoverTile, BackgroundActivityPill, BackLink, BookCover, Button, CenterDialog, CloseButton, CountBadge, GeneratedCover, IconButton, Menu, LinkTabs, RatingInput, StarRating, RelativeTime, PageIntro, PageTabs, Pagination, Popover, ProgressBar, SearchPill, SectionTitle, SegmentedControl, SelectPill, SideSheet, Slider, StatusDot, Stepper, ToggleChip, ToggleSwitch, Toolbar } from "../../src/ui";

export { coverTone } from "../../src/ui/cover";
export { relativeTimeLabel } from "../../src/ui/relative-time";

function Controls() {
  const [value, setValue] = createSignal("all"), [checked, setChecked] = createSignal(true), [size, setSize] = createSignal(21);
  const options = [{ value: "all", label: "全部" }, { value: "read", label: "已读" }];
  return <>
    <Button size="lg" count="2 本">开始入库</Button><Button variant="secondary">另存为</Button><Button variant="quiet">取消</Button>
    <IconButton aria-label="设置" title="设置">Aa</IconButton><CloseButton /><BackLink href="/">书库</BackLink>
    <SectionTitle>关于这本书</SectionTitle><CountBadge accent>48</CountBadge><BackgroundActivityPill count="2 进行中">最近任务</BackgroundActivityPill>
    <StatusDot label="已连接" tone="ok" /><ProgressBar label="全书进度" value={42} />
    <Slider label="行距" value={size()} min={12} max={30} onChange={setSize} /><Stepper label="字号" value={size()} min={12} max={30} onChange={setSize} />
    <ToggleSwitch label="推送生词" checked={checked()} onChange={setChecked} /><ToggleChip selected={checked()} onClick={() => setChecked(!checked())}>去掉书里自带的</ToggleChip>
    <SegmentedControl label="阅读状态" value={value()} options={options} onChange={setValue} />
    <SelectPill label="排序" value={value()} options={options} onChange={setValue} /><SearchPill label="搜索书名或作者" placeholder="搜索书名或作者" />
  </>;
}
function Covers() {
  return <><GeneratedCover book_id="a" title="浮生六记" author="沈复" state="read" />
    <GeneratedCover book_id="b" title="生成失败" state="failed" onRetry={() => {}} />
    <BookCover book_id="c" title="生成中" state="generating" progress={35} cover_url="/cover.jpg" />
    <GeneratedCover book_id="d" title="未入库" state="not-in-library" />
    <GeneratedCover book_id="e" title="小封面" compact /><AddCoverTile label="添加书籍" onClick={() => {}} /></>;
}
function Pages() {
  return <><PageIntro eyebrow="书库 · 在库 48 册" title="最近阅读的是这本。" description="接着上次的地方读。" actions={<Button size="lg">继续阅读 ↗</Button>} visual={<GeneratedCover book_id="ab" title="浮生六记" large />} />
    <PageTabs label="书库范围" value="active" tabs={[{ value: "active", label: "在库", count: 48 }, { value: "archived", label: "已归档", count: 3 }]} />
    <Toolbar search={<SearchPill label="书库搜索" placeholder="书名或作者" />}><Button variant="secondary">批量选择</Button></Toolbar>
    <Pagination page={1} total={48} perPage={12} unit="册" href="/?q=书#books" />
  </>;
}
function Overlays() {
  const [open, setOpen] = createSignal(false), [settings, setSettings] = createSignal(false);
  let trigger!: HTMLButtonElement, settingsTrigger!: HTMLButtonElement;
  return <><button ref={trigger} type="button" onClick={() => setOpen(true)}>打开</button>
    <SideSheet open={open()} title="最近任务" subtitle="2 进行中" onClose={() => setOpen(false)} actions={<Button>完成</Button>}><Button variant="secondary">操作</Button></SideSheet>
    <CenterDialog open={false} title="编辑追踪" onClose={() => {}}>字段</CenterDialog>
    <button ref={settingsTrigger} type="button" onClick={() => setSettings(true)}>阅读设置</button>
    <Popover open={settings()} title="阅读设置" anchor={() => settingsTrigger} onClose={() => setSettings(false)}>Aa</Popover>
    <Menu title="浮生六记" trigger={<span>浮生六记 · 沈复</span>} status="已读" statusTone="ok" items={[{ label: "删除追踪", destructive: true, onSelect() {} }, { label: "阅读", onSelect() {} }, { label: "编辑追踪", onSelect() {} }]} />
  </>;
}
function Consolidated() {
  const [rating, setRating] = createSignal("3"), [tab, setTab] = createSignal("all"), [callbacks, setCallbacks] = createSignal(0), [submits, setSubmits] = createSignal(0);
  return <>
    <Menu title="书籍操作" trigger={<span>操作 · 菜单</span>} status="已读" items={[
      { label: "编辑", onSelect: () => setCallbacks(n => n + 1) },
      { label: "阅读", href: "/book/a?return_to=%2F#chapter" },
      { label: "下载", href: "/book/a/download", native: true },
      { label: "不可用链接", href: "/disabled", disabled: true },
      { label: "不可用操作", onSelect() {}, disabled: true },
      { label: "归档", action: "/book/a/archive", fields: { next: "/?q=书#books" }, separatorBefore: true, onSubmit: event => { event.preventDefault(); setSubmits(n => n + 1); } },
      { label: "删除", action: "/book/a/delete", destructive: true, disabled: true },
    ]} />
    <output data-callbacks>{callbacks()}</output><output data-submits>{submits()}</output>
    <LinkTabs label="筛选链接" value={tab()} tabs={[
      { value: "all", label: "全部", href: "/?q=书&filter=all#books", count: 12 },
      { value: "unread", label: "未读", href: "/?q=书&filter=unread#books", count: 3 },
    ]} onNavigate={setTab} />
    <RatingInput value={rating()} onChange={setRating} showValue /><StarRating rating={Number(rating())} />
    <RelativeTime value="2026-10-26T00:30:00+08:00" labelPrefix="更新于" />
  </>;
}
const views = { controls: Controls, covers: Covers, pages: Pages, overlays: Overlays, consolidated: Consolidated };
export function markup(kind: keyof typeof views) { const View = views[kind]; return renderToString(() => <View />); }
export function mount(node: HTMLElement, kind: keyof typeof views) { const View = views[kind]; const dispose = render(() => <View />, node); flush(); return { dispose, flush }; }
