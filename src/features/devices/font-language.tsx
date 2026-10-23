import { For } from "solid-js";
import type { FontLanguage } from "../../client/devices/fonts";

export { matchesFontLanguage, type FontLanguage } from "../../client/devices/fonts";
const CHOICES: [FontLanguage, string][] = [["all", "全部"], ["cjk", "中文"], ["latin", "英文"]];

export function FontLanguageFilter(props: { value: FontLanguage; onChange: (value: FontLanguage) => void; disabled?: boolean }) {
  return <div class="segmented kt-font-filter" role="group" aria-label="按字体语言筛选">
    <For each={CHOICES}>{([value, label]) => <button type="button" aria-pressed={props.value === value ? "true" : "false"} disabled={props.disabled} onClick={() => props.onChange(value)}>{label}</button>}</For>
  </div>;
}
