import Icons from "unplugin-icons/vite";

/**
 * On-demand Tabler icons compiled to Solid components.
 *
 * The second plugin drops Tabler's 2px stroke from the generated glyph body so the
 * wrapper's `stroke-width` (default 1.7, overridable) inherits to every path.
 */
export function binderyIcons() {
  return [
    Icons({ compiler: "solid" }),
    {
      name: "bindery-tabler-stroke",
      enforce: "pre" as const,
      transform(code: string, id: string) {
        if (!/(?:^|[/\\])~icons[/\\]tabler[/\\]/.test(id) || !code.includes(' stroke-width="2"')) return;
        return { code: code.replace(/ stroke-width="2"/g, ""), map: null };
      },
    },
  ];
}
