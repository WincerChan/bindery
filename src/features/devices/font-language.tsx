import { For } from "solid-js";
import type { FontLanguage } from "../../client/devices/fonts";
import { Chip } from "../../ui";

export { matchesFontLanguage, type FontLanguage } from "../../client/devices/fonts";
const CHOICES: [FontLanguage, string][] = [["all", "全部"], ["cjk", "中文"], ["latin", "英文"]];

export function FontLanguageFilter(props: { value: FontLanguage; onChange: (value: FontLanguage) => void; disabled?: boolean }) {
  return <div class="kindle-filters" role="group" aria-label="按字体语言筛选">
    <For each={CHOICES}>{([value, label]) => <Chip variant="filter" selected={props.value === value} disabled={props.disabled} onClick={() => props.onChange(value)}>{label}</Chip>}</For>
  </div>;
}
