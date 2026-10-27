import { createContext, createSignal, onSettled, Show, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { PwaInstall, type InstallMode, type InstallState } from "../../client/pwa/install";
import { Dialog } from "../../ui";

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
  return <Show when={props.mode}><button type="button" class="settings-install-button" onClick={props.onInstall}>安装应用</button></Show>;
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
      <span class="settings-row-copy"><span class="settings-row-title">安装应用</span><span class="settings-row-status">{state().standalone ? "已安装 · 正在应用中打开" : state().mode ? "装到桌面，像普通应用一样打开" : "可在支持安装的浏览器菜单中安装应用"}</span></span>
      <InstallAppButton mode={state().mode} onInstall={() => void install()} />
    </div>
    <Dialog open={helpOpen()} title="安装应用" closeLabel="关闭安装说明" onClose={() => setHelpOpen(false)}>
      <p class="muted">点击 Safari 工具栏的分享按钮，然后选择「添加到主屏幕」。</p>
    </Dialog>
  </>;
}
