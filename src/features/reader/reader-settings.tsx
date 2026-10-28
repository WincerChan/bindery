import { For, Show } from "solid-js";
import { Button, IconButton, SegmentedControl, Slider } from "../../ui";
import type { ReaderSettings } from "./model";
import { readerPaper } from "./reader-presentation";

/** Margins read as 窄 / 中 / 宽 in the Aa sheet; the stored value stays in px. */
export function marginLabel(value: number) {
  return Math.max(0, value) <= 24 ? "窄" : Math.max(0, value) <= 40 ? "中" : "宽";
}

/** The design's font-size control is the two-A stepper, not a generic −/+ pair. */
function SizeStepper(props: { value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void }) {
  return <div class="ui-stepper reader-size-stepper" role="group" aria-label="字号">
    <IconButton class="reader-size-step reader-size-step-small" aria-label="减小字号" title="减小字号" disabled={props.disabled || props.value <= props.min} onClick={() => props.onChange(Math.max(props.min, props.value - 1))}><span aria-hidden="true">A</span></IconButton>
    <output aria-live="polite" aria-label="字号">{props.value}</output>
    <IconButton class="reader-size-step reader-size-step-large" aria-label="增大字号" title="增大字号" disabled={props.disabled || props.value >= props.max} onClick={() => props.onChange(Math.min(props.max, props.value + 1))}><span aria-hidden="true">A</span></IconButton>
  </div>;
}

/** The shared controls do not include font preview cards or paper swatches. */
export function ReaderSettingsControls(props: { value: ReaderSettings; onChange: (value: ReaderSettings) => void }) {
  const update = <K extends keyof ReaderSettings>(name: K, value: ReaderSettings[K]) => props.onChange({ ...props.value, [name]: value });
  const custom = () => props.value.styleMode === "custom";
  return <div class="reader-settings-controls">
    <SegmentedControl label="样式来源" value={props.value.styleMode} options={[{ value: "book", label: "书籍原样" }, { value: "custom", label: "自定义" }]} onChange={value => update("styleMode", value as ReaderSettings["styleMode"])} />
    <Show when={!custom()}><p class="reader-style-hint">保留书中的字体与排版。选择「自定义」可调整下方设置。</p></Show>
    <div class="reader-font-cards" role="group" aria-label="字体">
      <For each={[{ value: "serif", label: "衬线", sample: "文" }, { value: "sans", label: "无衬线", sample: "文" }, { value: "mono", label: "等宽", sample: "Aa" }] as const}>{font =>
        <Button variant="secondary" class={`reader-font-card reader-font-${font.value}`} aria-label={font.label} aria-pressed={props.value.fontFamily === font.value ? "true" : "false"} disabled={!custom()} onClick={() => update("fontFamily", font.value)}><span aria-hidden="true">{font.sample}</span><span>{font.label}</span></Button>
      }</For>
    </div>
    <Show when={props.value.fontFamily === "kai"}><p class="reader-style-hint">当前沿用已保存的楷体。</p></Show>
    <div class="reader-size-row"><span>字号</span><SizeStepper value={props.value.fontSize} min={12} max={28} disabled={!custom()} onChange={value => update("fontSize", value)} /></div>
    <Slider label="行高" min={1.2} max={2.4} step={0.05} value={props.value.lineHeight} formatValue={value => String(Number(value.toFixed(2)))} disabled={!custom()} onChange={value => update("lineHeight", value)} />
    <Slider label="左右边距" min={0} max={48} value={props.value.pagePaddingX} formatValue={marginLabel} disabled={!custom()} onChange={value => update("pagePaddingX", value)} />
    <Slider label="上下边距" min={0} max={48} value={props.value.pagePaddingY} formatValue={marginLabel} disabled={!custom()} onChange={value => update("pagePaddingY", value)} />
    <div class="reader-paper-row"><span>纸张</span><div role="group" aria-label="纸张" class="reader-paper-swatches">
      <For each={[{ value: "paper", label: "米白" }, { value: "white", label: "纯白" }, { value: "dark", label: "暗色" }] as const}>{paper =>
        <IconButton class={`reader-paper-swatch reader-paper-${paper.value}`} aria-label={paper.label} title={paper.label} aria-pressed={readerPaper(props.value) === paper.value ? "true" : "false"} onClick={() => props.onChange({ ...props.value, readerBg: paper.value === "white" ? "book" : "paper", brightnessMode: paper.value === "dark" ? "dim" : "bright" })}><span aria-hidden="true" /></IconButton>
      }</For>
    </div></div>
    <SegmentedControl label="对齐" value={props.value.textAlignMode} disabled={!custom()} options={[{ value: "justify", label: "两端对齐" }, { value: "left", label: "左对齐" }]} onChange={value => update("textAlignMode", value as ReaderSettings["textAlignMode"])} />
    <Show when={["center", "right"].includes(props.value.textAlignMode)}><p class="reader-style-hint">当前沿用已保存的{props.value.textAlignMode === "center" ? "居中" : "右对齐"}。</p></Show>
  </div>;
}
