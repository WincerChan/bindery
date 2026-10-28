import { createSignal, onSettled, Show } from "solid-js";
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, cancelPasskeyCeremony, loginWithPasskey, passkeyMessage } from "../../client/passkeys";
import { Button, Icon, PageHeader } from "../../ui";

export interface LoginScreenData {
  hash_configured: boolean;
  next: string;
  error: string | null;
  passkey_available: boolean;
}

export function LoginScreen(props: { data: LoginScreenData }) {
  // SSR assumes the advertised passkey is usable; the client verifies support
  // once mounted. Without JavaScript, <details> still exposes the password form.
  const [supported, setSupported] = createSignal(typeof window === "undefined"),
    [busy, setBusy] = createSignal(false),
    [message, setMessage] = createSignal(""),
    [passwordOpen, setPasswordOpen] = createSignal(Boolean(props.data.error));
  const passkeyPrimary = () => props.data.passkey_available && supported();
  onSettled(() => {
    if (typeof window === "undefined") return;
    setSupported(browserSupportsWebAuthn());
    if (!props.data.passkey_available || !supported()) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!(await browserSupportsWebAuthnAutofill()) || cancelled || !passkeyPrimary()) return;
        await loginWithPasskey(props.data.next, { autofill: true });
      } catch (error) {
        // This request is aborted when the explicit button or navigation starts.
        if (cancelled || (error instanceof Error && ["AbortError", "NotAllowedError"].includes(error.name))) return;
        setMessage(passkeyMessage(error));
      }
    })();
    return () => { cancelled = true; cancelPasskeyCeremony(); };
  });
  async function login() {
    if (busy()) return;
    setBusy(true);
    setMessage("");
    setPasswordOpen(false);
    try {
      await loginWithPasskey(props.data.next);
    } catch (error) {
      setMessage(passkeyMessage(error));
      setPasswordOpen(true);
    } finally {
      setBusy(false);
    }
  }
  const passwordForm = () => <form action="/login" method="post" class="form-stack">
    <input type="hidden" name="next" value={props.data.next} />
    <label>密码<input type="password" name="password" autocomplete={passkeyPrimary() ? "current-password webauthn" : "current-password"} required disabled={busy()} /></label>
    <Button type="submit" size="lg" class="login-submit" disabled={busy() || !props.data.hash_configured}>登录</Button>
  </form>;
  return <main class="auth-page">
    <PageHeader title="Bindery" description="登录你的私人书库" />
    <Show when={props.data.error}><p class="notice" role="alert">{props.data.error}</p></Show>
    <Show when={!props.data.hash_configured}><p class="notice" role="alert">未配置 BINDERY_PASSWORD_HASH，无法使用密码登录。</p></Show>
    <Show when={passkeyPrimary()}>
      <Button variant="primary" class="login-passkey" disabled={busy()} onClick={login}>{busy() ? "等待验证…" : "使用通行密钥登录"}</Button>
      <Show when={message()}><p class="notice" role="alert">{message()}</p></Show>
      <details class="login-password" open={passwordOpen()} onToggle={event => setPasswordOpen(event.currentTarget.open)}>
        <summary>使用密码登录<Icon name={passwordOpen() ? "minus" : "plus"} size={16} class="ui-icon-inline" /></summary>
        {passwordForm()}
      </details>
    </Show>
    <Show when={!passkeyPrimary()}>
      <Show when={message()}><p class="notice" role="alert">{message()}</p></Show>
      {passwordForm()}
    </Show>
  </main>;
}
