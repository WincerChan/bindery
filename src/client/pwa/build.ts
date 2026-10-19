import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Manifest, type Plugin } from "vite";
import { manifest } from "./manifest.ts";
import { isBuildAsset } from "./policy.ts";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const publicAssets = ["manifest.json", "offline.html", "favicon.svg", ...manifest.icons.map(icon => icon.src.slice(1))];

/** Manifest entries cover lazy routes; output files also cover separate Vite Worker builds. */
export function collectPrecache(clientManifest: Manifest, outputFiles: readonly string[]): string[] {
  const files = Object.values(clientManifest).flatMap(entry => [entry.file, ...entry.css ?? [], ...entry.assets ?? []]);
  return [...new Set([...publicAssets, ...files.filter(isBuildAsset), ...outputFiles.filter(isBuildAsset)])].sort();
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? listFiles(root, prefix + entry.name + "/") : [prefix + entry.name]))).flat();
}

export function pwaBuild(): Plugin {
  return {
    name: "bindery:pwa",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/manifest.json" || !["GET", "HEAD"].includes(request.method ?? "")) return next();
        response.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache");
        response.end(request.method === "HEAD" ? undefined : JSON.stringify(manifest));
      });
    },
    // Keep the prebuilt boko files available even before the Kindle route is loaded.
    // The Kindle Worker's own bundled glue and ?url WASM are picked up below too.
    async generateBundle() {
      if (this.environment.name !== "client") return;
      const vendor = resolve(sourceDir, "../../..", "vendor/boko");
      const wasm = this.emitFile({ type: "asset", name: "boko_bg.wasm", source: await readFile(resolve(vendor, "boko_bg.wasm")) });
      const glue = await readFile(resolve(vendor, "boko.js"), "utf8");
      const wasmName = this.getFileName(wasm).split("/").at(-1)!;
      this.emitFile({ type: "asset", name: "boko.js", source: glue.replace("new URL('boko_bg.wasm', import.meta.url)", `new URL('${wasmName}', import.meta.url)`) });
      this.emitFile({ type: "asset", fileName: "manifest.json", source: JSON.stringify(manifest, null, 2) + "\n" });
      this.emitFile({ type: "asset", fileName: "offline.html", source: await readFile(resolve(sourceDir, "offline.html")) });
    },
    writeBundle: {
      order: "post",
      async handler(options) {
        if (this.environment.name !== "client") return;
        const output = resolve(options.dir!);
        const clientManifest = JSON.parse(await readFile(resolve(output, ".vite/manifest.json"), "utf8")) as Manifest;
        const precache = collectPrecache(clientManifest, await listFiles(output));
        const hash = createHash("sha256");
        for (const file of precache) { hash.update(file); hash.update(await readFile(resolve(output, file))); }
        for (const file of ["worker.ts", "policy.ts"]) hash.update(await readFile(resolve(sourceDir, file)));
        const version = hash.digest("hex").slice(0, 20);
        // A standalone classic worker at the origin root needs no Service-Worker-Allowed header.
        const result = await build({
          configFile: false, envFile: false, publicDir: false, logLevel: "silent",
          define: { __PWA_BUILD__: JSON.stringify({ version, precache }) },
          build: {
            write: false, minify: true, target: "es2022",
            lib: { entry: resolve(sourceDir, "worker.ts"), name: "BinderyPwa", formats: ["iife"] },
          },
        });
        if (!Array.isArray(result) || result.length !== 1) throw new Error("Unexpected PWA worker build output");
        const worker = result[0].output.find(entry => entry.type === "chunk");
        if (!worker || worker.type !== "chunk") throw new Error("Missing PWA worker");
        await writeFile(resolve(output, "sw.js"), worker.code);
        // Audit artifact is hidden by the production static server's dotfiles:false.
        await writeFile(resolve(output, ".vite/pwa.json"), JSON.stringify({ version, precache }, null, 2) + "\n");
      },
    },
  };
}
