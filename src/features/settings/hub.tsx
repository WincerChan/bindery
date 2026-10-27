import { Link } from "../../shared/spa-link";
import type { SettingsSummary } from "../../server/settings/summary";
import { InstallApp } from "./install-app";
import { Button, Icon, SectionTitle, StatusDot, type IconName } from "../../ui";
import "./settings-hub.css";

export function relativeLastUse(value: string | null, now: number): string {
  if (!value) return "尚未使用";
  const date = new Date(value), elapsed = Math.max(0, now - date.getTime());
  if (!Number.isFinite(elapsed)) return "使用时间未知";
  if (elapsed < 60_000) return "刚刚用过";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前用过`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前用过`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前用过`;
  return `${value.slice(5, 10)} 用过`;
}
function SettingsRow(props: { href: string; title: string; status: string; icon: IconName; connected?: boolean }) {
  return <Link class="settings-row" href={props.href}>
    <span class="settings-row-icon" aria-hidden="true"><Icon name={props.icon} size={20} /></span>
    <span class="settings-row-copy"><span class="settings-row-title">{props.title}</span><span class="settings-row-status">{props.connected ? <StatusDot label="已配置" tone="ok" /> : null}{props.status}</span></span>
    <span aria-hidden="true"><Icon name="chevron-right" size={18} /></span>
  </Link>;
}
export function SettingsHub(props: { summary: SettingsSummary; now: number }) {
  const rules = () => props.summary.rules, themes = () => props.summary.themes, security = () => props.summary.security, lexi = () => props.summary.lexitrace;
  return <section class="settings-hub" aria-labelledby="settings-title">
    <h1 id="settings-title" class="page-title">设置</h1>
    <div class="settings-groups">
      <section aria-labelledby="settings-books"><SectionTitle id="settings-books">书怎么做出来</SectionTitle>
        <SettingsRow href="/rules" title="切章规则" icon="list-details" status={`${rules().count} 条${rules().recently_modified ? ` · 最近改过「${rules().recently_modified!.name}」` : " · 尚未添加规则"}`} />
        <SettingsRow href="/themes" title="主题" icon="palette" status={`${themes().count} 个${themes().ingest_default ? ` · 入库默认用「${themes().ingest_default!.name} v${themes().ingest_default!.version}」` : " · 尚未添加主题"}`} />
      </section>
      <section aria-labelledby="settings-account"><SectionTitle id="settings-account">账号与连接</SectionTitle>
        <SettingsRow href="/security" title="安全" icon="shield-check" status={`${security().passkey_count} 个通行密钥 · ${relativeLastUse(security().last_used_at, props.now)}`} />
        <SettingsRow href="/vocabulary?settings=lexitrace#lexitrace-settings" title="LexiTrace" connected={lexi().configured} icon="vocabulary" status={lexi().configured ? `已配置 · ${lexi().enabled ? "生词自动推送" : "自动推送已关闭"}` : "未配置 · 连接后可自动推送生词"} />
        <InstallApp />
      </section>
      <section class="settings-devices" aria-labelledby="settings-devices"><SectionTitle id="settings-devices">设备</SectionTitle>
        <div class="settings-device-link"><SettingsRow href="/devices" title="Kindle 与 Kobo" status="连接阅读器、传书与安装字体" icon="device-tablet" /></div>
        <div class="settings-device-note settings-row"><span class="settings-row-icon" aria-hidden="true"><Icon name="device-tablet" size={20} /></span><span class="settings-row-copy"><span class="settings-row-title">Kindle 与 Kobo</span><span class="settings-row-status">手机浏览器连不上阅读器。传书、装字体、看排版预览，请在电脑上用 Chrome 或 Edge 打开 Bindery。</span></span></div>
      </section>
      <form class="settings-logout" action="/logout" method="post"><Button type="submit" variant="quiet-danger" size="lg"><Icon name="logout" size={18} />退出登录</Button></form>
    </div>
  </section>;
}
