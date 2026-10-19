import type { Options } from "vite-plugin-solid";

// Solid rc.15 can allocate condition memos inside component prop getters.
// SSR/client getter reads differ, drifting hydration IDs and leaving live
// effects attached to detached DOM. Disable that optimization for both builds.
// See docs/solid-client-rendering.md for the reproducer and removal criteria.
export const solidOptions = {
  ssr: true,
  solid: { wrapConditionals: false },
} satisfies Options;
