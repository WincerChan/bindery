import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal, For, onSettled, Show } from "solid-js";
import { browserSupportsWebAuthn, passkeyMessage, PasskeyRequestError, postJson, registerPasskey } from "../client/passkeys";
const getSecurityData = createServerFn({
  method: "GET"
}).handler(async () => (await import("../server/auth-views")).securityData());
export const Route = createFileRoute("/security")({
  loader: () => getSecurityData(),
  head: () => ({
    meta: [{
      title: "安全 · Bindery"
    }]
  }),
  component: Security
});
function Security() {
  const data = Route.useLoaderData(),
    [supported, setSupported] = createSignal(false),
    [busy, setBusy] = createSignal(false),
    [message, setMessage] = createSignal(""),
    [needsPassword, setNeedsPassword] = createSignal(false),
    [name, setName] = createSignal(""),
    [password, setPassword] = createSignal("");
  onSettled(() => {
    if (typeof window !== "undefined") setSupported(browserSupportsWebAuthn());
  });
  async function add(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (needsPassword()) {
        await postJson("/security/reauth", {
          password: password()
        });
        setPassword("");
        setNeedsPassword(false);
      }
      await registerPasskey(name());
      location.assign("/security?toast=" + encodeURIComponent("已添加通行密钥"));
    } catch (error) {
      if (error instanceof PasskeyRequestError && error.code === "needs_password") {
        setNeedsPassword(true);
        setMessage("添加通行密钥前，请先验证密码。");
      } else setMessage(passkeyMessage(error));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  async function rename(event: SubmitEvent, id: string) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement,
      value = new FormData(form).get("name");
    setBusy(true);
    setMessage("");
    try {
      await postJson(`/security/passkeys/${encodeURIComponent(id)}/rename`, {
        name: value
      });
      setMessage("已重命名通行密钥");
    } catch (error) {
      setMessage(passkeyMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return <main class="security-page">
    <nav><a href="/">书库</a><form action="/logout" method="post"><button class="quiet" type="submit">退出登录</button></form></nav>
    <p class="eyebrow">ACCOUNT SECURITY</p><h1>安全</h1><p class="muted">通行密钥保存在设备或密码管理器中，用指纹、面容或设备密码即可登录。</p>
    <Show when={data().toast}><p role="status" class="notice">{data().toast}</p></Show>
    <Show when={message()}><p role="status" class="notice">{message()}</p></Show>
    <Show when={!data().passkey_configured}><p class="notice">通行密钥不可用：未配置有效的 BINDERY_PUBLIC_ORIGIN。本地开发请用 http://localhost:端口 访问。</p></Show>
    <Show when={data().passkey_configured && !supported()}><p class="muted">当前浏览器不支持通行密钥。</p></Show>
    <section><h2>通行密钥 · {data().passkeys.length}</h2>
      <Show when={!data().passkeys.length}><p class="muted">还没有通行密钥。添加后，下次登录无需输入密码。</p></Show>
      <For each={data().passkeys}>{key => <article class="passkey-row">
        <p>{key.device_type === "multi_device" || key.backed_up ? "已同步" : "仅此设备"} · 创建 {key.created_at.slice(0, 10)} · 最近使用 {key.last_used_at?.slice(0, 10) || "从未"}</p>
        <form class="inline-form" onSubmit={e => rename(e, key.credential_id)}>
          <label>名称<input name="name" value={key.name} maxlength={40} disabled={busy() || !data().passkey_configured} /></label>
          <button type="submit" disabled={busy() || !data().passkey_configured}>重命名</button>
        </form>
        <form action={`/security/passkeys/${encodeURIComponent(key.credential_id)}/delete`} method="post" onSubmit={e => {
            if (!window.confirm("删除后将无法再用它登录。确定删除？")) e.preventDefault();
          }}><button type="submit" class="quiet danger" disabled={busy() || !data().passkey_configured}>删除通行密钥</button></form>
      </article>}</For>
    </section>
    <Show when={data().passkey_configured && supported()}><section><h2>添加通行密钥</h2>
      <form class="form-stack" onSubmit={add}>
        <label>名称<input name="name" maxlength={40} value={name()} onInput={e => setName(e.currentTarget.value)} placeholder="例如：我的电脑" disabled={busy()} /></label>
        <Show when={needsPassword()}><label>验证密码<input type="password" autocomplete="current-password" value={password()} onInput={e => setPassword(e.currentTarget.value)} required disabled={busy()} /></label></Show>
        <button type="submit" disabled={busy()}>{busy() ? "等待验证…" : needsPassword() ? "验证密码并添加" : "添加通行密钥"}</button>
      </form>
    </section></Show>
    <section><h2>密码</h2><p class="muted">密码始终可作为备用登录方式。修改密码请更新 BINDERY_PASSWORD_HASH 并重启服务。</p></section>
  </main>;
}
