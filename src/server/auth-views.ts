import { getRequest } from "@tanstack/solid-start/server";
import { configuredHash, safeNext, webauthnConfig } from "./auth";
import { publicPasskey } from "./auth-http";
export { passkeyEnrollmentPrompt } from "./auth";
import { getLibrary } from "./runtime";
import type { BinderyDatabase } from "./db";
export function loginData(request = getRequest(), db: BinderyDatabase = getLibrary().db) {
  const url = new URL(request.url);
  return {
    hash_configured: Boolean(configuredHash()),
    next: safeNext(url.searchParams.get("next")),
    error: url.searchParams.get("error"),
    passkey_available: Boolean(webauthnConfig(request)) && db.countPasskeys() > 0
  };
}
export function securityData() {
  const request = getRequest();
  return {
    passkeys: getLibrary().db.listPasskeys().map(publicPasskey),
    passkey_configured: Boolean(webauthnConfig(request)),
    toast: new URL(request.url).searchParams.get("toast")
  };
}
