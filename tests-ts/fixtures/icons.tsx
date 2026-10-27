import { hydrate, renderToString } from "@solidjs/web";
import { flush, Loading } from "solid-js";
import { Icon } from "../../src/ui/icon";

function View() {
  return <div data-icon-probe>
    <Icon name="books" />
    <Icon name="star-filled" label="已收藏" size={28} strokeWidth={2.25} class="custom-icon" />
    <Icon name="refresh" size={16} strokeWidth={1.2} />
  </div>;
}

export function markup() {
  return renderToString(() => <Loading><View /></Loading>);
}

export function mount(root: HTMLElement) {
  const dispose = hydrate(() => <Loading><View /></Loading>, root);
  return { dispose, flush };
}
