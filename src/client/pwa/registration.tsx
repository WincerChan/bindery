import { onSettled } from "solid-js";
import { registerPwa } from "./register";

export function PwaRegistration() {
  onSettled(() => { if (import.meta.env.PROD) return registerPwa(); });
  return null;
}
