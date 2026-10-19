import { browserSupportsWebAuthn, startAuthentication, startRegistration, type PublicKeyCredentialRequestOptionsJSON, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
export { browserSupportsWebAuthn };
export class PasskeyRequestError extends Error {
  constructor(message: string, readonly code = "server") {
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
  if (response.redirected) {
    location.assign(response.url);
    throw new PasskeyRequestError("请重新登录");
  }
  const data = await response.json();
  if (!response.ok) throw new PasskeyRequestError(data.error || "请求失败，请重试。", data.error === "needs_password" ? "needs_password" : "server");
  return data as T;
}
export async function loginWithPasskey(next: string): Promise<void> {
  const optionsJSON = await postJson<PublicKeyCredentialRequestOptionsJSON>("/login/passkey/options");
  const credential = await startAuthentication({
    optionsJSON
  });
  const result = await postJson<{
    redirect: string;
  }>("/login/passkey/verify", {
    credential,
    next
  });
  location.assign(result.redirect);
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
