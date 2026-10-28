import { Outlet, useLocation, useMatches } from "@tanstack/solid-router";
import { createMemo, For, Show } from "solid-js";
import { Link } from "../shared/spa-link";
import { Icon } from "../ui";
import { PwaInstallProvider } from "../features/settings/install-app";
import { navigation, navActive, phoneNavigation, settingsLink } from "./navigation";
import "./shell.css";

export function AppShell() {
  const location = useLocation(), matches = useMatches();
  // Loader refreshes replace matches; only a real layout change should replace the Outlet.
  const readerLayout = createMemo(() => matches().some(match => match.staticData.readerLayout));
  const active = (href: string) => navActive(location().pathname, href);
  return <PwaInstallProvider>
    <a class="skip-link" href="#app-content">跳到正文</a>
    <div class={readerLayout() ? "reader-layout" : "page-shell"}>
      <Show when={!readerLayout()}><aside class="nav-rail" aria-label="应用导航"><div class="nav-rail-content">
        <Link href="/" class="brand" aria-label="Bindery · 回书库" title="回书库"><img class="brand-mark" src="/logo.svg" width="30" height="30" alt="" /></Link>
        <nav class="desktop-nav" aria-label="主导航"><For each={navigation}>{item =>
          <Link href={item.href} class={`nav-link ${active(item.href) ? "active" : ""}`} aria-label={item.label} title={item.label} aria-current={active(item.href) ? "page" : undefined}><Icon icon={item.icon} size={22} /></Link>
        }</For></nav>
        <Link href={settingsLink.href} class={`nav-link rail-settings ${active(settingsLink.href) ? "active" : ""}`} aria-label={settingsLink.label} title={settingsLink.label} aria-current={active(settingsLink.href) ? "page" : undefined}><Icon icon={settingsLink.icon} size={22} /></Link>
      </div></aside></Show>
      <main id="app-content" tabindex={-1} class={readerLayout() ? "reader-main" : "app-main"}>
        {readerLayout() ? <Outlet /> : <div class="app-content"><Outlet /></div>}
      </main>
    </div>
    <Show when={!readerLayout()}><nav class="tab-bar" aria-label="手机导航"><For each={phoneNavigation}>{item =>
      <Link href={item.href} class={`tab ${active(item.href) ? "active" : ""}`} aria-current={active(item.href) ? "page" : undefined}><span class="tab-icon"><Icon icon={item.icon} size={22} /></span><span>{item.label}</span></Link>
    }</For></nav></Show>
  </PwaInstallProvider>;
}
