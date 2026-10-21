import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration, WebAuthnAbortService, type PublicKeyCredentialRequestOptionsJSON, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { loginTarget } from "../shared/session-navigation";
export { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill };
export class PasskeyRequestError extends Error {
  constructor(message: string, readonly code = "server", readonly target?: string) {
    super(message);
  }
}
export async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (path.startsWith("/security/")) checkSession(response);
  if (response.redirected) {
    throw new PasskeyRequestError("请重新登录", "login", loginTarget(location.pathname + location.search));
  }
  const data = await response.json();
  if (!response.ok) throw new PasskeyRequestError(data.error || "请求失败，请重试。", data.error === "needs_password" ? "needs_password" : "server");
  return data as T;
}
function checkSession(response: Response) {
  const target = response.headers.get("HX-Redirect") || response.headers.get("Location") || (response.redirected ? response.url : "");
  const login = target && new URL(target, location.href).pathname === "/login";
  if (response.status === 401 || login) {
    throw new PasskeyRequestError("请重新登录", "login", loginTarget(location.pathname + location.search));
  }
}
export async function deletePasskey(id: string): Promise<void> {
  const response = await fetch(`/security/passkeys/${encodeURIComponent(id)}/delete`, {
    method: "POST", credentials: "same-origin", redirect: "manual",
    // An expired session must yield a visible 401 rather than an opaque
    // redirect, indistinguishable from the delete endpoint's success 303.
    headers: { "HX-Request": "true" },
  });
  checkSession(response);
  if (response.type === "opaqueredirect" || response.status === 303) return;
  const data = await response.json().catch(() => ({}));
  throw new PasskeyRequestError(data.error || "删除失败，请重试。");
}
export async function loginWithPasskey(next: string, options: { autofill?: boolean } = {}): Promise<void> {
  const autofill = Boolean(options.autofill);
  // A conditional request may be waiting in the password autofill UI. Abort it
  // before starting an explicit button ceremony so only one prompt is active.
  if (!autofill) WebAuthnAbortService.cancelCeremony();
  const optionsJSON = await postJson<PublicKeyCredentialRequestOptionsJSON>("/login/passkey/options");
  const credential = await startAuthentication({
    optionsJSON,
    useBrowserAutofill: autofill
  });
  const result = await postJson<{
    redirect: string;
  }>("/login/passkey/verify", {
    credential,
    next
  });
  location.assign(result.redirect);
}
export function cancelPasskeyCeremony(): void {
  WebAuthnAbortService.cancelCeremony();
}
export async function reauthenticateWithPasskey(): Promise<void> {
  const optionsJSON = await postJson<PublicKeyCredentialRequestOptionsJSON>("/security/reauth/passkey/options");
  const credential = await startAuthentication({
    optionsJSON
  });
  await postJson("/security/reauth/passkey/verify", {
    credential
  });
}
export async function registerPasskey(name: string): Promise<void> {
  const optionsJSON = await postJson<PublicKeyCredentialCreationOptionsJSON>("/security/passkeys/register/options");
  const credential = await startRegistration({
    optionsJSON
  });
  await postJson("/security/passkeys/register/verify", {
    credential,
    name
  });
}
export function passkeyMessage(error: unknown): string {
  if (error instanceof Error) {
    if (["NotAllowedError", "AbortError"].includes(error.name) || /cancell?ed/i.test(error.message)) return "已取消。";
    if (error.name === "InvalidStateError") return "这个设备已经添加过通行密钥。";
    return error.message;
  }
  return "请求失败，请重试。";
}
