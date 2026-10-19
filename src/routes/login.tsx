import { createFileRoute } from "@tanstack/solid-router";
import { createIsomorphicFn } from "@tanstack/solid-start";
import { createSignal, onSettled, Show } from "solid-js";
import { browserSupportsWebAuthn, loginWithPasskey, passkeyMessage } from "../client/passkeys";
const getLoginData = createIsomorphicFn().server(async () => (await import("../server/auth-views")).loginData()).client(async () => {
  const response = await fetch("/login/data" + window.location.search, {
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error("无法加载登录信息");
  return response.json() as Promise<{
    hash_configured: boolean;
    next: string;
    error: string | null;
    passkey_available: boolean;
  }>;
});
export const Route = createFileRoute("/login")({
  loader: () => getLoginData(),
  head: () => ({
    meta: [{
      title: "登录 · Bindery"
    }]
  }),
  component: Login
});
function Login() {
  const data = Route.useLoaderData(),
    [supported, setSupported] = createSignal(false),
    [busy, setBusy] = createSignal(false),
    [message, setMessage] = createSignal("");
  onSettled(() => {
    if (typeof window !== "undefined") setSupported(browserSupportsWebAuthn());
  });
  async function login() {
    setBusy(true);
    setMessage("");
    try {
      await loginWithPasskey(data().next);
    } catch (error) {
      setMessage(passkeyMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return <main class="auth-page">
    <p class="eyebrow">PRIVATE LIBRARY</p><h1>Bindery</h1><p class="muted">登录你的私人书库</p>
    <Show when={data().error}><p class="notice" role="alert">{data().error}</p></Show>
    <Show when={!data().hash_configured}><p class="notice" role="alert">未配置 BINDERY_PASSWORD_HASH，无法使用密码登录。</p></Show>
    <Show when={data().passkey_available && supported()}><button type="button" disabled={busy()} onClick={login}>{busy() ? "等待验证…" : "使用通行密钥登录"}</button><p class="muted divider">或使用密码</p></Show>
    <Show when={message()}><p class="notice" role="status">{message()}</p></Show>
    <form action="/login" method="post" class="form-stack">
      <input type="hidden" name="next" value={data().next} />
      <label>密码<input type="password" name="password" autocomplete="current-password" required disabled={busy()} /></label>
      <button type="submit" disabled={busy() || !data().hash_configured}>登录</button>
    </form>
  </main>;
}
