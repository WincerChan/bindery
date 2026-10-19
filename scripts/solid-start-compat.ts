import type { Plugin } from "vite";

// solid-start rc.8 still calls the pre-rc.15 URL helpers. Solid rc.15 split
// action addresses (id|string) from data addresses (GET function reference).
// Adapt only that upstream integration module, in dev and production alike.
// No dependency files are changed. Remove when upstream adopts the new names.
export function solidStartRcCompatibility(): Plugin {
  return {
    name: "bindery:solid-start-rc-url-compatibility",
    enforce: "pre",
    transform(code, id) {
      if (
        !/\/@tanstack\/solid-start\/(?:dist\/esm|src)\/server-functions-handler\.[jt]s$/.test(
          id,
        )
      )
        return;
      if (!code.includes("parseServerFunctionUrl")) return;
      return {
        code: code
          .replace(
            /\bparseServerFunctionUrl\b/g,
            "parseServerFunctionActionUrl",
          )
          .replace(/\bserverFunctionUrl\b/g, "serverFunctionActionUrl"),
        map: null,
      };
    },
  };
}
