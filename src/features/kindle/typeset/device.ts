import { createSignal, onCleanup, onSettled } from "solid-js";
import { errorMessage } from "../../../client/kindle/fs";
import type { DeviceState, KindleDeviceManager, RememberedDevice } from "../../../client/kindle";

/** Device state enters the render tree only after mount, including when a manager already has a device. */
export function usePageDevice(manager: KindleDeviceManager | null) {
  const [state, setState] = createSignal<DeviceState | null>(null);
  const [remembered, setRemembered] = createSignal<RememberedDevice[]>([]);
  const [memoryError, setMemoryError] = createSignal("");
  let disposed = false, unsubscribe: (() => void) | undefined;
  onSettled(() => {
    if (!manager || disposed) return;
    unsubscribe = manager.subscribe(setState);
    setState(manager.snapshot());
    void manager.remembered().then(value => { if (!disposed) setRemembered(value); }, error => { if (!disposed) setMemoryError(errorMessage(error)); });
  });
  onCleanup(() => { disposed = true; unsubscribe?.(); });
  return { state, remembered, memoryError };
}
