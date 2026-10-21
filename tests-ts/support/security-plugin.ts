import type { Plugin } from "vite";

/** Stub only the server loader and WebAuthn hardware boundary, never the UI,
 * passkeys HTTP helpers, Router, fetch implementation, or mutation lifecycle. */
export function securityPlugin(): Plugin {
  const virtual = "\0bindery-test-webauthn";
  return {
    name: "bindery-security-test-boundaries", enforce: "pre",
    resolveId(id) { if (id === "@simplewebauthn/browser") return virtual; },
    load(id) {
      if (id === virtual) return `export const browserSupportsWebAuthn = () => true;
        export const browserSupportsWebAuthnAutofill = async () => false;
        export const WebAuthnAbortService = { cancelCeremony: () => globalThis.__binderyTestCancelCeremony?.() };
        export const startRegistration = (options) => globalThis.__binderyTestRegistration(options);
        export const startAuthentication = (options) => globalThis.__binderyTestAuthentication
          ? globalThis.__binderyTestAuthentication(options)
          : Promise.reject(new Error('Unexpected authentication ceremony'));`;
    },
    transform(code, id) {
      if (!id.endsWith("/src/routes/_app.security.tsx")) return;
      return code.replace('import { createServerFn } from "@tanstack/solid-start";', "")
        .replace('import { authenticated } from "../server/functions";', "")
        .replace(/const getSecurityData = createServerFn[\s\S]*?(?=export const Route)/, "const getSecurityData = () => globalThis.__binderyTestSecurityData();\n");
    },
  };
}
