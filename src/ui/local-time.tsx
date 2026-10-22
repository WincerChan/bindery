import { createSignal, onSettled } from "solid-js";

const pad = (n: number) => String(n).padStart(2, "0");
const label = (date: Date, utc: boolean) => utc
  ? `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

/**
 * An ISO time in the viewer's own time zone. The server renders UTC (its zone is not the reader's) and the
 * browser switches to local time once mounted, so hydration still matches.
 */
export function LocalTime(props: { value: string; class?: string }) {
  const date = () => new Date(props.value), valid = () => Number.isFinite(date().getTime());
  const [local, setLocal] = createSignal(false);
  onSettled(() => { setLocal(true); });
  return <time class={props.class} datetime={props.value} title={valid() && !local() ? "UTC" : undefined}>{valid() ? label(date(), !local()) : props.value}</time>;
}
