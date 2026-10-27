import { isRedirect, useRouter } from "@tanstack/solid-router";
import { createSignal, For, onSettled, Show } from "solid-js";
import { browserSupportsWebAuthn, deletePasskey, passkeyMessage, PasskeyRequestError, postJson, reauthenticateWithPasskey, registerPasskey } from "../../client/passkeys";
import { showToast } from "../../client/toast";
import { BackLink, Button, ConfirmDialog, PageIntro, SectionTitle } from "../../ui";
import "./security.css";

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
    [password, setPassword] = createSignal(""),
    [deleting, setDeleting] = createSignal<SecurityPasskey | null>(null);
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
  async function remove() {
    const key = deleting();
    if (busy() || !key) return;
    setBusy(true); setMessage("");
    try { await deletePasskey(key.credential_id); setDeleting(null); showToast("已删除通行密钥"); await router.invalidate(); }
    catch (error) { await failure(error); }
    finally { setBusy(false); }
  }
  let enrollmentName!: HTMLInputElement;
  return <div class="settings-security">
    <BackLink href="/settings">设置</BackLink>
    <div class="settings-security-layout">
    <PageIntro eyebrow={null} title="安全" description="用通行密钥登录就不必再输密码：面容、指纹或设备密码都行。密码一直可以作为备用。" actions={<Button size="lg" disabled={busy() || !props.data.passkey_configured || !supported()} onClick={() => { enrollmentName?.scrollIntoView?.({ block: "center" }); enrollmentName?.focus(); }}>添加通行密钥</Button>} />
    <div class="settings-security-keys">
    <Show when={message()}><p role="status" class="notice">{message()}</p></Show>
    <Show when={!props.data.passkey_configured}><p class="notice">通行密钥不可用：未配置有效的 BINDERY_PUBLIC_ORIGIN。本地开发请用 http://localhost:端口 访问。</p></Show>
    <Show when={props.data.passkey_configured && !supported()}><p class="muted">当前浏览器不支持通行密钥。</p></Show>
    <section aria-labelledby="security-keys-title"><SectionTitle id="security-keys-title">已添加的通行密钥 · {props.data.passkeys.length}</SectionTitle>
      <Show when={!hasPasskeys()}><p class="muted">还没有通行密钥。添加后，下次登录无需输入密码。</p></Show>
      <For each={props.data.passkeys}>{key => <article class="settings-security-key" aria-label={key.name}>
        <h3>{key.name}</h3><p>{key.device_type === "multi_device" || key.backed_up ? "已同步" : "仅此设备"} · 创建 {key.created_at.slice(0, 10)} · 最近使用 {key.last_used_at?.slice(0, 10) || "从未"}</p>
        <form class="settings-security-rename" action={`/security/passkeys/${encodeURIComponent(key.credential_id)}/rename`} method="post" onSubmit={e => rename(e, key.credential_id)}>
          <label>名称<input name="name" value={key.name} maxlength={40} disabled={busy() || !props.data.passkey_configured} /></label>
          <Button type="submit" variant="secondary" disabled={busy() || !props.data.passkey_configured}>重命名</Button>
        </form>
        <form action={`/security/passkeys/${encodeURIComponent(key.credential_id)}/delete`} method="post" onSubmit={event => { event.preventDefault(); setDeleting(key); }}><Button type="submit" variant="quiet-danger" aria-label={`删除通行密钥 ${key.name}`} disabled={busy() || !props.data.passkey_configured}>删除通行密钥</Button></form>
      </article>}</For>
    </section>
    <section class="settings-security-password"><SectionTitle>密码</SectionTitle><p class="muted">密码始终可作为备用登录方式。修改密码请更新 BINDERY_PASSWORD_HASH 并重启服务。</p></section>
    </div>
    <Show when={props.data.passkey_configured && supported()}><section class="settings-security-enroll" aria-labelledby="security-enroll-title"><SectionTitle id="security-enroll-title">添加通行密钥</SectionTitle>
      <p class="muted">{hasPasskeys() ? "添加前请先重新验证身份。" : "首次添加需要先验证密码。"}</p>
      <form class="form-stack" onSubmit={add}>
        <label>名称<input ref={enrollmentName} name="name" maxlength={40} value={name()} onInput={e => setName(e.currentTarget.value)} placeholder="例如：我的电脑" disabled={busy()} /></label>
        <Show when={needsPassword()}><label>验证密码<input type="password" autocomplete="current-password" value={password()} onInput={e => setPassword(e.currentTarget.value)} required disabled={busy()} /></label></Show>
        <Show when={!needsPassword()}><p class="muted">将使用已保存的通行密钥确认是你本人。</p></Show>
        <div class="form-actions">
          <Button type="submit" disabled={busy()}>{busy() ? "等待验证…" : needsPassword() ? "验证密码并添加" : "用通行密钥验证并添加"}</Button>
          <Show when={hasPasskeys()}><Button variant="quiet" disabled={busy()} onClick={() => setUsePassword(value => !value)}>{usePassword() ? "改用通行密钥验证" : "改用密码验证"}</Button></Show>
        </div>
      </form>
    </section></Show>
    </div>
    <ConfirmDialog open={Boolean(deleting())} title="删除通行密钥？" danger confirmLabel="删除" onClose={() => { if (!busy()) setDeleting(null); }} onConfirm={remove}>
      <p>删除「{deleting()?.name}」后，将无法再使用它登录。此操作不会影响其他通行密钥或密码登录。</p>
    </ConfirmDialog>
  </div>;
}
