import { isRedirect, useRouter } from "@tanstack/solid-router";
import { createSignal, For, onSettled, Show } from "solid-js";
import { browserSupportsWebAuthn, deletePasskey, passkeyMessage, PasskeyRequestError, postJson, reauthenticateWithPasskey, registerPasskey } from "../../client/passkeys";
import { showToast } from "../../client/toast";
import { PageHeader } from "../../ui";

export interface SecurityPasskey {
  credential_id: string;
  name: string;
  device_type: string | null;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}
export interface SecurityScreenData {
  passkeys: SecurityPasskey[];
  passkey_configured: boolean;
  toast: string | null;
}
export function SecurityScreen(props: { data: SecurityScreenData }) {
  const router = useRouter();
  async function failure(error: unknown) {
    if (isRedirect(error)) { await router.navigate({ href: error.options.href || "/login" }); return; }
    if (error instanceof PasskeyRequestError && error.code === "login") { await router.navigate({ href: error.target || "/login" }); return; }
    const message = passkeyMessage(error); setMessage(message); showToast(message, "error");
  }
  const [supported, setSupported] = createSignal(false),
    [busy, setBusy] = createSignal(false),
    [message, setMessage] = createSignal(""),
    [usePassword, setUsePassword] = createSignal(false),
    [name, setName] = createSignal(""),
    [password, setPassword] = createSignal("");
  const hasPasskeys = () => props.data.passkeys.length > 0,
    needsPassword = () => !hasPasskeys() || usePassword();
  onSettled(() => {
    if (typeof window !== "undefined") setSupported(browserSupportsWebAuthn());
  });
  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setMessage("");
    try {
      if (needsPassword()) {
        await postJson("/security/reauth", {
          password: password()
        });
      } else {
        await reauthenticateWithPasskey();
      }
      setPassword("");
      await registerPasskey(name());
      showToast("已添加通行密钥"); setName(""); setUsePassword(false); await router.invalidate();
    } catch (error) {
      if (error instanceof PasskeyRequestError && error.code === "needs_password") {
        setUsePassword(true);
        setMessage(hasPasskeys() ? "验证已过期，请重新验证密码。" : "添加通行密钥前，请先验证密码。");
      } else await failure(error);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  async function rename(event: SubmitEvent, id: string) {
    event.preventDefault();
    if (busy()) return;
    const form = event.currentTarget as HTMLFormElement,
      value = new FormData(form).get("name");
    setBusy(true);
    setMessage("");
    try {
      await postJson(`/security/passkeys/${encodeURIComponent(id)}/rename`, { name: value });
      setMessage("已重命名通行密钥"); showToast("已重命名通行密钥"); await router.invalidate();
    } catch (error) {
      await failure(error);
    } finally {
      setBusy(false);
    }
  }
  async function remove(event: SubmitEvent, id: string) {
    event.preventDefault();
    if (busy() || !window.confirm("删除后将无法再用它登录。确定删除？")) return;
    setBusy(true); setMessage("");
    try { await deletePasskey(id); showToast("已删除通行密钥"); await router.invalidate(); }
    catch (error) { await failure(error); }
    finally { setBusy(false); }
  }
  return <div class="security-page">
    <PageHeader title="安全" description="通行密钥保存在设备或密码管理器中，用指纹、面容或设备密码即可登录。" />
    <Show when={message()}><p role="status" class="notice">{message()}</p></Show>
    <Show when={!props.data.passkey_configured}><p class="notice">通行密钥不可用：未配置有效的 BINDERY_PUBLIC_ORIGIN。本地开发请用 http://localhost:端口 访问。</p></Show>
    <Show when={props.data.passkey_configured && !supported()}><p class="muted">当前浏览器不支持通行密钥。</p></Show>
    <section><h2>通行密钥 · {props.data.passkeys.length}</h2>
      <Show when={!hasPasskeys()}><p class="muted">还没有通行密钥。添加后，下次登录无需输入密码。</p></Show>
      <For each={props.data.passkeys}>{key => <article class="passkey-row">
        <p>{key.device_type === "multi_device" || key.backed_up ? "已同步" : "仅此设备"} · 创建 {key.created_at.slice(0, 10)} · 最近使用 {key.last_used_at?.slice(0, 10) || "从未"}</p>
        <form class="inline-form" onSubmit={e => rename(e, key.credential_id)}>
          <label>名称<input name="name" value={key.name} maxlength={40} disabled={busy() || !props.data.passkey_configured} /></label>
          <button type="submit" disabled={busy() || !props.data.passkey_configured}>重命名</button>
        </form>
        <form action={`/security/passkeys/${encodeURIComponent(key.credential_id)}/delete`} method="post" onSubmit={e => { void remove(e, key.credential_id); }}><button type="submit" class="quiet danger" disabled={busy() || !props.data.passkey_configured}>删除通行密钥</button></form>
      </article>}</For>
    </section>
    <Show when={props.data.passkey_configured && supported()}><section><h2>添加通行密钥</h2>
      <p class="muted">{hasPasskeys() ? "添加前请先重新验证身份。" : "首次添加需要先验证密码。"}</p>
      <form class="form-stack" onSubmit={add}>
        <label>名称<input name="name" maxlength={40} value={name()} onInput={e => setName(e.currentTarget.value)} placeholder="例如：我的电脑" disabled={busy()} /></label>
        <Show when={needsPassword()}><label>验证密码<input type="password" autocomplete="current-password" value={password()} onInput={e => setPassword(e.currentTarget.value)} required disabled={busy()} /></label></Show>
        <Show when={!needsPassword()}><p class="muted">将使用已保存的通行密钥确认是你本人。</p></Show>
        <div class="form-actions">
          <button type="submit" disabled={busy()}>{busy() ? "等待验证…" : needsPassword() ? "验证密码并添加" : "用通行密钥验证并添加"}</button>
          <Show when={hasPasskeys()}><button type="button" class="quiet" disabled={busy()} onClick={() => setUsePassword(value => !value)}>{usePassword() ? "改用通行密钥验证" : "改用密码验证"}</button></Show>
        </div>
      </form>
    </section></Show>
    <section><h2>密码</h2><p class="muted">密码始终可作为备用登录方式。修改密码请更新 BINDERY_PASSWORD_HASH 并重启服务。</p></section>
  </div>;
}
