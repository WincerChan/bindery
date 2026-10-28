import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { binderyIcons } from "./scripts/vite-icons.ts";
import { solidOptions } from "./scripts/solid-options.ts";
export default defineConfig({
  plugins: [...binderyIcons(), solid(solidOptions)],
  test: {
    environment: "node", include: ["tests-ts/**/*.test.ts"], testTimeout: 30000,
    // Full default-parallel build hooks measured up to 21.7s; a 30s trial still
    // timed out. Give compilation 60s headroom without extending individual tests.
    hookTimeout: 60000,
  },
});
