import "./scripts/load-env.mjs";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import solid from "vite-plugin-solid";
import tailwind from "@tailwindcss/vite";
import { solidStartRcCompatibility } from "./scripts/solid-start-compat.ts";
import { solidOptions } from "./scripts/solid-options.ts";
import { pwaBuild } from "./src/client/pwa/build.ts";

export default defineConfig({
  plugins: [
    solidStartRcCompatibility(),
    tanstackStart(),
    solid(solidOptions),
    tailwind(),
    pwaBuild(),
  ],
  environments: {
    ssr: {
      build: {
        // Keep src/server and dist/server at the same depth for Python path defaults.
        rollupOptions: { output: { chunkFileNames: "[name]-[hash].js" } },
      },
    },
  },
});
