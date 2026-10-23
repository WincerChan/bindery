import type { Plugin } from "vite";

// Component-only builds do not run Start's compiler. Replace the RPC boundary,
// not the components, Router, or business services. Production builds use Start.
export function mutationPlugin(): Plugin {
  const names = ["mutateLibrarySelection", "retryJob", "cleanupInvalidJobs", "saveBook", "lookupBook", "mutateBook", "saveTracker", "deleteTracker", "checkTracker", "createTemplate", "removeTemplate", "saveTemplate", "testTemplate", "rebuildTemplate", "listTypesetProfiles", "createTypesetProfile", "updateTypesetProfile", "deleteTypesetProfile", "getDeviceTypeset", "saveDeviceTypeset"];
  return { name: "test-mutation-rpc", enforce: "pre", load(id) {
    if (!/\/src\/features\/(books|catalog|library|ingest)\/mutations\.ts$/.test(id) && !id.endsWith("/src/server/typeset/functions.ts")) return;
    return names.map(name => `export const ${name} = input => globalThis.__binderyTestMutation ? globalThis.__binderyTestMutation(${JSON.stringify(name)}, input) : Promise.reject(new Error("Unexpected RPC: ${name}"));`).join("\n");
  } };
}
