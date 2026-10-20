import { Outlet, useLocation, useMatches } from "@tanstack/solid-router";
import { createEffect, createSignal, For, Show } from "solid-js";
import { Dialog } from "../ui";
import { gearIcon, navigation, navActive, settings } from "./navigation";

function Gear() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={gearIcon} stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /><circle cx="12" cy="12.5" r="3" stroke="currentColor" stroke-width="1.6" /></svg>;
}
export function AppShell() {
  const location = useLocation(), [moreOpen, setMoreOpen] = createSignal(false), [menuOpen, setMenuOpen] = createSignal(false);
  const matches = useMatches();
  let menu!: HTMLDivElement, gear!: HTMLButtonElement;
  const readerLayout = () => matches().some(match => match.staticData.readerLayout);
  const close = () => { setMoreOpen(false); setMenuOpen(false); };
  createEffect(() => location().href, close);
  createEffect(readerLayout, reading => { if (reading) close(); });
  createEffect(menuOpen, open => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setMenuOpen(false); gear.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  });
  const active = (href: string) => navActive(location().pathname, href);
  const settingsActive = () => settings.some(item => active(item.href));
  return <>
    <a class="skip-link" href="#app-content">跳到正文</a>
    <Show when={!readerLayout()}><header class="site-header"><div class="wrap header-row">
      <a href="/" class="brand"><span class="brand-mark" aria-hidden="true" />Bindery</a>
      <nav class="desktop-nav" aria-label="主导航"><For each={navigation}>{item =>
        <a href={item.href} class={`nav-link ${active(item.href) ? "active" : ""}`} aria-current={active(item.href) ? "page" : undefined}>{item.label}</a>
      }</For><div class="settings-menu" ref={menu}>
        <button ref={gear} type="button" class={`nav-link settings-toggle ${menuOpen() || settingsActive() ? "active" : ""}`} aria-label="设置" aria-haspopup="menu" aria-expanded={menuOpen() ? "true" : "false"} aria-controls="desktop-settings" onClick={() => setMenuOpen(value => !value)}><Gear /></button>
        <div id="desktop-settings" class="settings-dropdown" role="menu" hidden={!menuOpen()}>
          <For each={settings}>{item => <a role="menuitem" class="sheet-row" href={item.href} aria-current={active(item.href) ? "page" : undefined} onClick={close}>{item.label}</a>}</For>
          <hr /><form action="/logout" method="post" onSubmit={close}><button type="submit" role="menuitem" class="sheet-row">退出登录</button></form>
        </div>
      </div></nav>
    </div></header></Show>
    <main id="app-content" tabindex={-1} class={readerLayout() ? "reader-main" : "wrap app-main"}><Outlet /></main>
    <Show when={!readerLayout()}><nav class="tab-bar" aria-label="手机导航"><For each={navigation.filter(item => item.href !== "/kindle")}>{item =>
      <a href={item.href} class={`tab ${!moreOpen() && active(item.href) ? "active" : ""}`} aria-current={active(item.href) ? "page" : undefined}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={item.icon} stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>{item.label}</a>
    }</For><button type="button" class={`tab ${moreOpen() || settingsActive() ? "active" : ""}`} aria-label="设置" aria-expanded={moreOpen() ? "true" : "false"} aria-controls="more-sheet" onClick={() => setMoreOpen(true)}><Gear />设置</button></nav>
    <Dialog id="more-sheet" open={moreOpen()} title="设置" closeLabel="关闭设置" class="more-sheet" onClose={() => setMoreOpen(false)}>
      <div><For each={settings}>{item => <a class="sheet-row" href={item.href} aria-current={active(item.href) ? "page" : undefined} onClick={close}>{item.label}<span aria-hidden="true">→</span></a>}</For>
      <form action="/logout" method="post" onSubmit={close}><button type="submit" class="sheet-row">退出登录</button></form></div>
    </Dialog></Show>
  </>;
}
