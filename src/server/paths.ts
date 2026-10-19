import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnv } from "./env";

// Vite keeps server chunks flat in dist/server, matching src/server's depth.
// This preserves Python's repository-relative defaults independently of cwd.
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function libraryPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const library = readEnv("BINDERY_LIBRARY_DIR", env);
  return library ? resolve(cwd, library) : resolve(projectRoot, "library");
}
