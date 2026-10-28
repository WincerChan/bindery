import TablerArrowLeft from "~icons/tabler/arrow-left";
import TablerChevronDown from "~icons/tabler/chevron-down";
import TablerMinus from "~icons/tabler/minus";
import TablerPlus from "~icons/tabler/plus";
import TablerX from "~icons/tabler/x";
import { createUniqueId, For, Match, omit, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Link } from "../shared/spa-link";
import { Icon, type IconComponent } from "./icon";
import { Button, TextField } from "./controls";
import type { ButtonProps } from "./controls";

export function IconButton(props: Omit<ButtonProps, "variant"> & { "aria-label": string; title: string }) {
  return <Button {...props} variant="icon" />;
}
export function CloseButton(props: Omit<ButtonProps, "variant">) {
  return <IconButton {...props} aria-label={props["aria-label"] || "关闭"} title={props.title || props["aria-label"] || "关闭"}><Icon icon={TablerX} size={18} /></IconButton>;
}
export function BackLink(props: { href: string; children: JSX.Element; class?: string }) {
  return <Link href={props.href} class={`ui-back-link ${props.class || ""}`}><span aria-hidden="true"><Icon icon={TablerArrowLeft} size={18} /></span>{props.children}</Link>;
}
export function SectionTitle(props: { children: JSX.Element; id?: string }) {
  return <h2 id={props.id} class="ui-section-title">{props.children}</h2>;
}
export function CountBadge(props: { children: JSX.Element; accent?: boolean }) {
  return <span class={`ui-count ${props.accent ? "is-accent" : ""}`}>{props.children}</span>;
}
export function BackgroundActivityPill(props: ButtonProps & { count: JSX.Element }) {
  return <Button {...props} variant="secondary" class={`ui-activity ${props.class || ""}`}><span class="ui-activity-dot" aria-hidden="true" />{props.children}</Button>;
}
export function StatusDot(props: { label: string; tone?: "ok" | "danger" | "empty" | "accent" }) {
  return <span role="img" aria-label={props.label} title={props.label} class={`ui-status-dot ui-status-${props.tone || "empty"}`} />;
}
export function ProgressBar(props: { label: string; value?: number; secondary?: boolean; class?: string }) {
  const value = () => Math.max(0, Math.min(100, props.value ?? 0));
  return <div role="progressbar" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.value === undefined ? undefined : value()} class={`ui-progress ${props.secondary ? "is-secondary" : ""} ${props.class || ""}`}><span style={{ width: `${props.value === undefined ? 40 : value()}%` }} /></div>;
}
export function Slider(props: { label: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean; formatValue?: (value: number) => string; onChange: (value: number) => void }) {
  const min = () => props.min ?? 0, max = () => props.max ?? 100;
  const percent = () => max() <= min() ? 0 : Math.max(0, Math.min(100, (props.value - min()) / (max() - min()) * 100));
  return <label class="ui-slider"><span>{props.label}</span><span class="ui-slider-control" style={{ "--slider-fill": `${percent()}%` }}>
    <span class="ui-slider-track" aria-hidden="true"><span /></span><span class="ui-slider-knob" aria-hidden="true" />
    <input type="range" aria-label={props.label} aria-valuetext={props.formatValue?.(props.value)} min={min()} max={max()} step={props.step ?? 1} value={props.value} disabled={props.disabled} onInput={event => props.onChange(event.currentTarget.valueAsNumber)} />
  </span><output>{props.formatValue?.(props.value) ?? props.value}</output></label>;
}
export function Stepper(props: { label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange: (value: number) => void }) {
  return <div class="ui-stepper" role="group" aria-label={props.label}><span aria-hidden="true">A</span>
    <IconButton aria-label={`减小${props.label}`} title={`减小${props.label}`} disabled={props.disabled || props.value <= props.min} onClick={() => props.onChange(Math.max(props.min, props.value - (props.step ?? 1)))}><Icon icon={TablerMinus} size={16} /></IconButton>
    <output aria-live="polite" aria-label={props.label}>{props.value}</output>
    <IconButton aria-label={`增大${props.label}`} title={`增大${props.label}`} disabled={props.disabled || props.value >= props.max} onClick={() => props.onChange(Math.min(props.max, props.value + (props.step ?? 1)))}><Icon icon={TablerPlus} size={16} /></IconButton><span aria-hidden="true" class="ui-stepper-large">A</span>
  </div>;
}
export function ToggleSwitch(props: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; describedBy?: string }) {
  return <button type="button" class="ui-switch" role="switch" aria-label={props.label} aria-describedby={props.describedBy} aria-checked={props.checked ? "true" : "false"} disabled={props.disabled} onClick={() => props.onChange(!props.checked)}><span aria-hidden="true" /></button>;
}
export type ControlOption = { value: string; label: string; icon?: IconComponent; disabled?: boolean };
export function SegmentedControl(props: { label: string; value: string; options: readonly ControlOption[]; onChange: (value: string) => void; disabled?: boolean; class?: string }) {
  return <div role="group" aria-label={props.label} class={`segmented ${props.class || ""}`}><For each={props.options}>{option => <button type="button" class={option.icon ? "is-icon" : undefined} aria-label={option.icon ? option.label : undefined} aria-pressed={props.value === option.value ? "true" : "false"} disabled={props.disabled || option.disabled} onClick={() => props.onChange(option.value)}>{option.icon ? <Icon icon={option.icon} size={18} /> : option.label}</button>}</For></div>;
}
export type LinkTab = { value: string; label: string; href: string; count?: number };
/** URL navigation uses anchors; local state changes use SegmentedControl. */
export function LinkTabs(props: { label: string; value: string; tabs: readonly LinkTab[]; class?: string; replace?: boolean; resetScroll?: boolean; hashScrollIntoView?: boolean; countSeparator?: string; accentCounts?: boolean; onNavigate?: (value: string) => void }) {
  return <nav aria-label={props.label} class={`segmented ui-link-tabs ${props.class || ""}`}><For each={props.tabs}>{tab =>
    <Link href={tab.href} replace={props.replace} resetScroll={props.resetScroll} hashScrollIntoView={props.hashScrollIntoView} aria-current={props.value === tab.value ? "page" : undefined}
      onClick={event => { if (props.onNavigate && !event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); props.onNavigate(tab.value); } }}>
      {tab.label}<Show when={tab.count !== undefined}>{props.countSeparator ?? " · "}<CountBadge accent={props.accentCounts || props.value === tab.value}>{tab.count}</CountBadge></Show>
    </Link>
  }</For></nav>;
}
export function ToggleChip(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  return <button {...omit(props, "selected", "class")} type={props.type || "button"} class={`chip ${props.selected ? "is-selected" : ""} ${props.class || ""}`} aria-pressed={props.selected ? "true" : "false"} />;
}
export function SelectPill(props: { label: string; value: string; options: readonly ControlOption[]; onChange: (value: string) => void; name?: string; disabled?: boolean; class?: string; icon?: IconComponent; showValue?: boolean }) {
  const id = createUniqueId();
  return <label for={id} class={`ui-select-pill ${props.icon ? "has-icon" : ""} ${props.showValue === false ? "is-label-only" : ""} ${props.class || ""}`}><Show when={props.icon}>{icon => <span class="ui-select-icon" aria-hidden="true"><Icon icon={icon()} size={16} /></span>}</Show><span class="ui-select-label">{props.label}</span><Show when={props.showValue !== false}><span class="ui-select-value" aria-hidden="true">{props.options.find(option => option.value === props.value)?.label ?? props.value}</span></Show><span class="ui-select-chevron" aria-hidden="true"><Icon icon={TablerChevronDown} size={14} /></span>
    <select id={id} name={props.name} aria-label={props.label} value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.currentTarget.value)}><For each={props.options}>{option => <option value={option.value} disabled={option.disabled}>{option.label}</option>}</For></select>
  </label>;
}
export function SearchPill(props: JSX.InputHTMLAttributes<HTMLInputElement> & { label: string; placeholder: string; class?: string }) {
  return <TextField {...omit(props, "class")} type="search" labelHidden class={`search-field ui-search-pill ${props.class || ""}`} />;
}
export type PageIntroVariant = "main" | "subpage" | "title-only" | "topbar" | "book";
export type PageIntroVisualSize = "cover" | "page" | "reading" | "vocabulary" | "device";
export function PageIntro(props: {
  eyebrow?: JSX.Element | null;
  title: JSX.Element;
  description?: JSX.Element;
  meta?: JSX.Element;
  content?: JSX.Element;
  status?: JSX.Element;
  note?: JSX.Element;
  actions?: JSX.Element;
  visual?: JSX.Element;
  variant?: PageIntroVariant;
  visualSize?: PageIntroVisualSize;
  back?: JSX.Element;
  titleId?: string;
  id?: string;
  class?: string;
  actionsClass?: string;
}) {
  const classes = () => ["ui-page-intro", props.variant && `ui-page-intro-${props.variant}`, props.visualSize && `ui-page-intro-visual-${props.visualSize}`, props.class].filter(Boolean).join(" ");
  const actions = () => <Show when={props.actions}><div class={`ui-page-actions ${props.actionsClass || ""}`}>{props.actions}</div></Show>;
  return <Switch fallback={<header id={props.id} class={classes()}>
    <Show when={props.back}><div class="ui-page-intro-back">{props.back}</div></Show>
    <div class="ui-page-intro-row">
      <div class="ui-page-intro-text">
        <Show when={props.eyebrow != null && props.eyebrow !== ""}><p class="ui-page-eyebrow">{props.eyebrow}</p></Show>
        <div class="ui-page-intro-lead">
          <h1 id={props.titleId}>{props.title}</h1>
          <Show when={props.meta}><div class="ui-page-meta">{props.meta}</div></Show>
          <Show when={props.description}><p class="ui-page-description">{props.description}</p></Show>
          <Show when={props.content}>{props.content}</Show>
        </div>
        <Show when={props.status}><div class="ui-page-status">{props.status}</div></Show>
        {actions()}
        <Show when={props.note}><div class="ui-page-note">{props.note}</div></Show>
      </div>
      <Show when={props.visual}><div class="ui-page-visual">{props.visual}</div></Show>
    </div>
  </header>}>
    <Match when={props.variant === "topbar"}><header id={props.id} class={classes()}>
      <Show when={props.back}><div class="ui-page-intro-back">{props.back}</div></Show>
      <h1 id={props.titleId} class="ui-page-intro-title">{props.title}</h1>
      {actions()}
    </header></Match>
    <Match when={props.visualSize === "cover" && props.variant !== "book"}><header id={props.id} class={classes()}>
      <Show when={props.back}><div class="ui-page-intro-back">{props.back}</div></Show>
      <div class="ui-page-intro-cover-grid">
        <div class="ui-page-intro-cover-text">
          <Show when={props.eyebrow != null && props.eyebrow !== ""}><p class="ui-page-eyebrow">{props.eyebrow}</p></Show>
          <div class="ui-page-intro-text"><div class="ui-page-intro-lead">
            <h1 id={props.titleId}>{props.title}</h1>
            <Show when={props.meta}><div class="ui-page-meta">{props.meta}</div></Show>
            <Show when={props.description}><p class="ui-page-description">{props.description}</p></Show>
            <Show when={props.content}>{props.content}</Show>
          </div></div>
          <div class="ui-page-intro-tail">
            <Show when={props.status}><div class="ui-page-status">{props.status}</div></Show>
            {actions()}
            <Show when={props.note}><div class="ui-page-note">{props.note}</div></Show>
          </div>
        </div>
        <Show when={props.visual}><div class="ui-page-visual">{props.visual}</div></Show>
      </div>
    </header></Match>
  </Switch>;
}
export function PageTabs(props: { label: string; value: string; tabs: readonly { value: string; label: string; count?: number; href?: string }[]; onChange?: (value: string) => void }) {
  return <nav class="ui-page-tabs" aria-label={props.label}><For each={props.tabs}>{tab => {
    const content = () => <>{tab.label}<Show when={tab.count !== undefined}><CountBadge accent={props.value === tab.value}>{tab.count}</CountBadge></Show></>;
    return <Show when={tab.href} fallback={<button type="button" aria-current={props.value === tab.value ? "page" : undefined} onClick={() => props.onChange?.(tab.value)}>{content()}</button>}>
      {href => <Link href={href()} aria-current={props.value === tab.value ? "page" : undefined}>{content()}</Link>}
    </Show>;
  }}</For></nav>;
}
export function Toolbar(props: { label?: string; search?: JSX.Element; children: JSX.Element }) {
  return <div class="ui-toolbar" role="group" aria-label={props.label || "筛选与视图"}><Show when={props.search}><div class="ui-toolbar-search">{props.search}</div></Show><div class="ui-toolbar-controls">{props.children}</div></div>;
}
