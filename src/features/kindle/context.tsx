import { createContext, onSettled, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { KindleDeviceManager } from "../../client/kindle";

// One manager per browser tab, created lazily on the client (SSR never touches the File System Access API).
let shared: KindleDeviceManager | null = null;
export function kindleManager(): KindleDeviceManager {
  return (shared ??= new KindleDeviceManager());
}

const KindleContext = createContext<() => KindleDeviceManager | null>(() => null);

/** Wraps the Kindle pages; starts connection monitoring on the client while any Kindle page is mounted. */
export function KindleProvider(props: { children: JSX.Element }) {
  const isClient = typeof window !== "undefined";
  // Same pattern as PwaRegistration: the returned function is the cleanup.
  onSettled(() => (isClient ? kindleManager().startMonitoring() : undefined));
  return <KindleContext value={() => (isClient ? kindleManager() : null)}>{props.children}</KindleContext>;
}

/** Returns the client-side manager, or null during SSR. */
export function useKindleManager(): KindleDeviceManager | null {
  return useContext(KindleContext)();
}
