import { Outlet, useLocation, useMatches } from "@tanstack/solid-router";
import { createEffect, createSignal, For, Show } from "solid-js";
import { Dialog } from "../ui";
import { navigation, navActive } from "./navigation";

const icons = ["M4 4h4v16H4zM10 4h4v16h-4zM17 5l3-.7 3 15-3 .7z", "M12 15V4M7 9l5-5 5 5M4 15v5h16v-5", "M4 6h16M4 12h10M4 18h7M18 13v6M15 16h6", "M6 3h12v18l-6-4-6 4z"];
export function AppShell() {
  const location = useLocation(), [moreOpen, setMoreOpen] = createSignal(false);
  const matches = useMatches();
  const readerLayout = () => matches().some(match => match.staticData.readerLayout);
  createEffect(readerLayout, reading => { if (reading) setMoreOpen(false); });
  const active = (href: string) => navActive(location().pathname, href);
  return <>
    <a class="skip-link" href="#app-content">跳到正文</a>
    <Show when={!readerLayout()}><header class="site-header"><div class="wrap header-row">
      <a href="/" class="brand"><span class="brand-mark" aria-hidden="true" />Bindery</a>
      <nav class="desktop-nav" aria-label="主导航"><For each={navigation}>{item =>
        <a href={item.href} class={`nav-link ${active(item.href) ? "active" : ""}`} aria-current={active(item.href) ? "page" : undefined}>{item.label}</a>
      }</For><form action="/logout" method="post"><button class="btn btn-quiet" type="submit">退出</button></form></nav>
    </div></header></Show>
    <main id="app-content" tabindex={-1} class={readerLayout() ? "reader-main" : "wrap app-main"}><Outlet /></main>
    <Show when={!readerLayout()}><nav class="tab-bar" aria-label="手机导航"><For each={navigation.slice(0, 4)}>{(item, index) =>
      <a href={item.href} class={`tab ${!moreOpen() && active(item.href) ? "active" : ""}`} aria-current={active(item.href) ? "page" : undefined}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={icons[index()]} stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>{item.label}</a>
    }</For><button type="button" class={`tab ${moreOpen() || navigation.slice(4).some(n => active(n.href)) ? "active" : ""}`} aria-expanded={moreOpen() ? "true" : "false"} aria-controls="more-sheet" onClick={() => setMoreOpen(true)}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>更多</button></nav>
    <Dialog id="more-sheet" open={moreOpen()} title="更多" closeLabel="关闭更多" class="more-sheet" onClose={() => setMoreOpen(false)}>
      <div><For each={navigation.slice(4)}>{item => <a class="sheet-row" href={item.href} aria-current={active(item.href) ? "page" : undefined}>{item.href === "/rules" ? "规则与主题" : item.href === "/security" ? "安全与通行密钥" : item.label}<span aria-hidden="true">→</span></a>}</For>
      <form action="/logout" method="post"><button type="submit" class="sheet-row">退出登录</button></form></div>
    </Dialog></Show>
  </>;
}
