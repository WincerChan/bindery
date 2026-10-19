import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Vite keeps server chunks flat in dist/server, matching src/server's depth.
// This preserves Python's repository-relative defaults independently of cwd.
export const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
