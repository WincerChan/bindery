// Solid 2 rc's ComponentProps<T> only accepts component types, so the upstream
// unplugin-icons Solid declaration (`ComponentProps<'svg'>`) resolves props to never.
// Declare the same on-demand imports against @solidjs/web's SVG attributes instead.
declare module "~icons/*" {
  import type { IconComponent } from "./ui/icon";

  const component: IconComponent;
  export default component;
}
