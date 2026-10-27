import { For, Show } from "solid-js";
import { Button } from "./controls";
import { Icon } from "./icon";

const stars = [1, 2, 3, 4, 5];
export function StarRating(props: { rating: number }) {
  return <span class="ui-stars" role="img" aria-label={`${props.rating} 星`}><For each={stars}>{n => <Icon name={n <= props.rating ? "star-filled" : "star"} size={14} class={n <= props.rating ? "ui-star-filled" : undefined} />}</For></span>;
}
export function RatingInput(props: { value: string; onChange: (value: string) => void; name?: string; label?: string; showValue?: boolean; outline?: boolean; class?: string }) {
  return <fieldset class={`ui-rating ${props.class || ""}`}><legend>{props.label || "评分"}</legend><input type="hidden" name={props.name || "rating"} value={props.value} /><div>
    <For each={stars}>{n => <Button variant="quiet" aria-label={`${n} 星`} aria-pressed={props.value === String(n) ? "true" : "false"} class={n <= Number(props.value) ? "ui-star-filled" : "ui-star-empty"} onClick={() => props.onChange(String(n))}><Icon name={props.outline && n > Number(props.value) ? "star" : "star-filled"} size={22} /></Button>}</For>
    <Button variant="quiet" aria-label="清除评分" onClick={() => props.onChange("")}>清除</Button>
    <Show when={props.showValue}><output>{props.value ? `${props.value} 星` : "未评分"}</output></Show>
  </div></fieldset>;
}
