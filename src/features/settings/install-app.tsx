import TablerDeviceMobileDown from "~icons/tabler/device-mobile-down";
import { createContext, createSignal, onSettled, Show, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { PwaInstall, type InstallMode, type InstallState } from "../../client/pwa/install";
import { Button, CenterDialog, Icon } from "../../ui";

function createInstallController() {
  const [state, setState] = createSignal<InstallState>({ mode: null, standalone: false });
  let installer: PwaInstall | undefined;
  onSettled(() => {
    if (typeof window === "undefined") return;
    installer = new PwaInstall(window);
    const unsubscribe = installer.subscribe(setState), stop = installer.start();
    return () => { unsubscribe(); stop(); };
  });
  return { state, prompt: () => installer?.prompt() };
}
const InstallContext = createContext<ReturnType<typeof createInstallController> | null>(null);
/** Capture the one-shot browser event on every page, not just after opening settings. */
export function PwaInstallProvider(props: { children: JSX.Element }) {
  const controller = createInstallController();
  return <InstallContext value={controller}>{props.children}</InstallContext>;
}
export function InstallAppButton(props: { mode: InstallMode | null; onInstall: () => void }) {
  return <Show when={props.mode}><Button variant="secondary" class="settings-install-button" onClick={props.onInstall}><span class="settings-only-desktop">安装</span><span class="settings-only-mobile">添加</span></Button></Show>;
}
export function InstallApp() {
  const { state, prompt } = useContext(InstallContext) ?? createInstallController();
  const [helpOpen, setHelpOpen] = createSignal(false);
  async function install() {
    if (state().mode === "ios") { setHelpOpen(true); return; }
    if (state().mode !== "prompt") return;
    try { await prompt(); } catch { /* The browser may cancel its install prompt. */ }
  }
  return <>
    <div class="settings-row settings-install">
      <span class="settings-row-icon" aria-hidden="true"><Icon icon={TablerDeviceMobileDown} size={20} /></span>
      <span class="settings-row-copy"><span class="settings-row-title"><span class="settings-only-desktop">安装应用</span><span class="settings-only-mobile">添加到主屏幕</span></span><span class="settings-row-status"><Show when={state().standalone} fallback={<Show when={state().mode} fallback="可在支持安装的浏览器菜单中安装应用"><span class="settings-only-desktop">装到桌面，像普通应用一样打开</span><span class="settings-only-mobile">像普通应用一样打开</span></Show>}>已安装 · 正在应用中打开</Show></span></span>
      <InstallAppButton mode={state().mode} onInstall={() => void install()} />
    </div>
    <CenterDialog open={helpOpen()} title="安装应用" closeLabel="关闭安装说明" onClose={() => setHelpOpen(false)}>
      <p class="muted">点击 Safari 工具栏的分享按钮，然后选择「添加到主屏幕」。</p>
    </CenterDialog>
  </>;
}
