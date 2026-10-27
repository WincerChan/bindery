import type { FontLanguage } from "../../client/devices/fonts";
import { SegmentedControl } from "../../ui";

export { matchesFontLanguage, type FontLanguage } from "../../client/devices/fonts";
const CHOICES: [FontLanguage, string][] = [["all", "全部"], ["cjk", "中文"], ["latin", "西文"]];

export function FontLanguageFilter(props: { value: FontLanguage; onChange: (value: FontLanguage) => void; disabled?: boolean }) {
  return <SegmentedControl label="按字体语言筛选" value={props.value} options={CHOICES.map(([value, label]) => ({ value, label }))} disabled={props.disabled} onChange={value => props.onChange(value as FontLanguage)} />;
}
