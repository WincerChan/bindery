import { Outlet, useLocation, useMatches } from "@tanstack/solid-router";
import { For, Show } from "solid-js";
import { Link } from "../shared/spa-link";
import { PwaInstallProvider } from "../features/settings/install-app";
import { gearIcon, navigation, navActive, phoneNavigation, settingsLink } from "./navigation";
import "./shell.css";

export function NavigationIcon(props: { icon: string }) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={props.icon} stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /><Show when={props.icon === gearIcon}><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" /></Show></svg>;
}
export function AppShell() {
  const location = useLocation(), matches = useMatches();
  const readerLayout = () => matches().some(match => match.staticData.readerLayout);
  const active = (href: string) => navActive(location().pathname, href);
  return <PwaInstallProvider>
    <a class="skip-link" href="#app-content">跳到正文</a>
    <div class={readerLayout() ? "reader-layout" : "app-frame"}>
      <div class={readerLayout() ? "reader-shell" : "page-shell"}>
        <Show when={!readerLayout()}><aside class="nav-rail" aria-label="应用导航"><div class="nav-rail-content">
          <Link href="/" class="brand" aria-label="Bindery · 回书库" title="回书库"><img class="brand-mark" src="/logo.svg" width="30" height="30" alt="" /></Link>
          <nav class="desktop-nav" aria-label="主导航"><For each={navigation}>{item =>
            <Link href={item.href} class={`nav-link ${active(item.href) ? "active" : ""}`} aria-label={item.label} title={item.label} aria-current={active(item.href) ? "page" : undefined}><NavigationIcon icon={item.icon} /></Link>
          }</For></nav>
          <Link href={settingsLink.href} class={`nav-link rail-settings ${active(settingsLink.href) ? "active" : ""}`} aria-label={settingsLink.label} title={settingsLink.label} aria-current={active(settingsLink.href) ? "page" : undefined}><NavigationIcon icon={settingsLink.icon} /></Link>
        </div></aside></Show>
        <main id="app-content" tabindex={-1} class={readerLayout() ? "reader-main" : "wrap app-main"}>
          <Outlet />
        </main>
      </div>
    </div>
    <Show when={!readerLayout()}><nav class="tab-bar" aria-label="手机导航"><For each={phoneNavigation}>{item =>
      <Link href={item.href} class={`tab ${active(item.href) ? "active" : ""}`} aria-current={active(item.href) ? "page" : undefined}><span class="tab-icon"><NavigationIcon icon={item.icon} /></span><span>{item.label}</span></Link>
    }</For></nav></Show>
  </PwaInstallProvider>;
}
