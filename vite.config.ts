import "./scripts/load-env.mjs";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import solid from "vite-plugin-solid";
import tailwind from "@tailwindcss/vite";
import { solidStartRcCompatibility } from "./scripts/solid-start-compat.ts";

export default defineConfig({
  plugins: [
    solidStartRcCompatibility(),
    tanstackStart(),
    solid({ ssr: true }),
    tailwind(),
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
