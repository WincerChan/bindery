import { hydrate, render, renderToString } from "@solidjs/web";
import { flush, Loading } from "solid-js";
import TablerBooks from "~icons/tabler/books";
import TablerRefresh from "~icons/tabler/refresh";
import TablerStarFilled from "~icons/tabler/star-filled";
import { Icon } from "../../src/ui/icon";

function View() {
  return <div data-icon-probe>
    <Icon icon={TablerBooks} />
    <Icon icon={TablerStarFilled} label="已收藏" size={28} strokeWidth={2.25} class="custom-icon" />
    <Icon icon={TablerRefresh} size={16} strokeWidth={1.2} />
  </div>;
}

export function markup() {
  return renderToString(() => <Loading><View /></Loading>);
}

export function mount(root: HTMLElement) {
  const dispose = hydrate(() => <Loading><View /></Loading>, root);
  return { dispose, flush };
}

export function renderClient(root: HTMLElement) {
  const dispose = render(() => <View />, root);
  return { dispose, flush };
}
