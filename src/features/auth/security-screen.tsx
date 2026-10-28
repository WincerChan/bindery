import TablerKey from "~icons/tabler/key";
import TablerPlus from "~icons/tabler/plus";
import TablerTrash from "~icons/tabler/trash";
import { isRedirect, useRouter } from "@tanstack/solid-router";
import { createSignal, For, onSettled, Show } from "solid-js";
import { browserSupportsWebAuthn, deletePasskey, passkeyMessage, PasskeyRequestError, postJson, reauthenticateWithPasskey, registerPasskey } from "../../client/passkeys";
import { showToast } from "../../client/toast";
import { BackLink, Button, CenterDialog, ConfirmDialog, Icon, PageIntro, RelativeTime, SectionTitle, TextField } from "../../ui";
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
    [enrolling, setEnrolling] = createSignal(false),
    [renaming, setRenaming] = createSignal<SecurityPasskey | null>(null),
    [renameName, setRenameName] = createSignal(""),
    [deleting, setDeleting] = createSignal<SecurityPasskey | null>(null);
  const hasPasskeys = () => props.data.passkeys.length > 0,
    canEnroll = () => props.data.passkey_configured && supported(),
    needsPassword = () => !hasPasskeys() || usePassword();
  onSettled(() => {
    if (typeof window !== "undefined") setSupported(browserSupportsWebAuthn());
  });
  let enrollmentName!: HTMLInputElement;
  function openEnrollment() {
    if (!canEnroll() || busy()) return;
    setEnrolling(true);
    enrollmentName?.focus();
  }
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
  function openRename(key: SecurityPasskey) {
    if (busy()) return;
    setRenameName(key.name);
    setRenaming(key);
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
      setRenaming(null);
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
  return <div class="settings-security">
    <div class="settings-security-layout">
      <div class="settings-security-hero">
        <BackLink href="/settings">设置</BackLink>
        <PageIntro eyebrow={null} title="安全" description="用通行密钥登录就不必再输密码：Windows Hello、面容或指纹都行。密码一直可以作为备用。" actions={<Button size="lg" disabled={busy() || !props.data.passkey_configured || !supported()} onClick={openEnrollment}><Icon icon={TablerPlus} size={16} />添加通行密钥</Button>} />
        <Show when={enrolling() && canEnroll()}><section class="settings-security-enroll" aria-labelledby="security-enroll-title"><SectionTitle id="security-enroll-title">添加通行密钥</SectionTitle>
          <p class="muted">{hasPasskeys() ? "添加前请先重新验证身份。" : "首次添加需要先验证密码。"}</p>
          <form class="form-stack" onSubmit={add}>
            <label>名称<input ref={enrollmentName} name="name" maxlength="40" value={name()} onInput={e => setName(e.currentTarget.value)} placeholder="例如：我的电脑" disabled={busy()} /></label>
            <Show when={needsPassword()}><label>验证密码<input type="password" autocomplete="current-password" value={password()} onInput={e => setPassword(e.currentTarget.value)} required disabled={busy()} /></label></Show>
            <Show when={!needsPassword()}><p class="muted">将使用已保存的通行密钥确认是你本人。</p></Show>
            <div class="form-actions">
              <Button type="submit" disabled={busy()}>{busy() ? "等待验证…" : needsPassword() ? "验证密码并添加" : "用通行密钥验证并添加"}</Button>
              <Show when={hasPasskeys()}><Button variant="quiet" disabled={busy()} onClick={() => setUsePassword(value => !value)}>{usePassword() ? "改用通行密钥验证" : "改用密码验证"}</Button></Show>
            </div>
          </form>
        </section></Show>
      </div>
      <div class="settings-security-keys">
        <Show when={message()}><p role="status" class="notice">{message()}</p></Show>
        <Show when={!props.data.passkey_configured}><p class="notice">通行密钥不可用：未配置有效的 BINDERY_PUBLIC_ORIGIN。本地开发请用 http://localhost:端口 访问。</p></Show>
        <Show when={props.data.passkey_configured && !supported()}><p class="muted">当前浏览器不支持通行密钥。</p></Show>
        <section aria-labelledby="security-keys-title"><SectionTitle id="security-keys-title">已添加的通行密钥 · {props.data.passkeys.length}</SectionTitle>
          <Show when={!hasPasskeys()}><p class="muted">还没有通行密钥。添加后，下次登录无需输入密码。</p></Show>
          <ul class="settings-security-key-list"><For each={props.data.passkeys}>{key => <li class="settings-security-key">
            <span class="settings-security-key-icon" aria-hidden="true"><Icon icon={TablerKey} size={22} /></span>
            <span class="settings-security-key-copy">
              <h3 class="settings-security-key-name">{key.name}</h3>
              <span class="settings-security-key-meta">{key.device_type === "multi_device" || key.backed_up ? "已同步" : "仅此设备"} · <RelativeTime value={key.created_at} /> 添加 · {key.last_used_at ? <><RelativeTime value={key.last_used_at} /> 用过</> : "尚未用过"}</span>
            </span>
            <Button variant="secondary" disabled={busy() || !props.data.passkey_configured} onClick={() => openRename(key)}>重命名</Button>
            <form action={`/security/passkeys/${encodeURIComponent(key.credential_id)}/delete`} method="post" onSubmit={event => { event.preventDefault(); setDeleting(key); }}><Button type="submit" variant="quiet-danger" class="settings-security-delete" aria-label={`删除通行密钥 ${key.name}`} title="删除" disabled={busy() || !props.data.passkey_configured}><Icon icon={TablerTrash} size={18} /></Button></form>
          </li>}</For></ul>
        </section>
        <p class="settings-security-password">要改密码，更新服务器上的 BINDERY_PASSWORD_HASH 后重启。</p>
      </div>
    </div>
    <CenterDialog open={Boolean(renaming())} title="重命名通行密钥" onClose={() => { if (!busy()) setRenaming(null); }}>
      <Show when={renaming()}>{key => <form action={`/security/passkeys/${encodeURIComponent(key().credential_id)}/rename`} method="post" onSubmit={event => rename(event, key().credential_id)} class="form-stack">
        <TextField label="名称" name="name" required maxlength={40} value={renameName()} onInput={event => setRenameName(event.currentTarget.value)} disabled={busy()} />
        <div class="form-actions"><Button variant="quiet" disabled={busy()} onClick={() => setRenaming(null)}>取消</Button><Button type="submit" disabled={busy()}>确认</Button></div>
      </form>}</Show>
    </CenterDialog>
    <ConfirmDialog open={Boolean(deleting())} title="删除通行密钥？" danger confirmLabel="删除" onClose={() => { if (!busy()) setDeleting(null); }} onConfirm={remove}>
      <p>删除「{deleting()?.name}」后，将无法再使用它登录。此操作不会影响其他通行密钥或密码登录。</p>
    </ConfirmDialog>
  </div>;
}
