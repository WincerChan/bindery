import { renderToString } from "@solidjs/web";
import { LoginScreen, type LoginScreenData } from "../../../src/features/auth/login-screen";

import { SecurityScreen, type SecurityScreenData } from "../../../src/features/auth/security-screen";
export function security(data: SecurityScreenData) { return renderToString(() => <SecurityScreen data={data} />); }

function loginData(passkey_available: boolean): LoginScreenData {
  return { hash_configured: true, next: "/?q=a:b", error: null, passkey_available };
}
export function login(passkey_available: boolean) {
  return renderToString(() => <LoginScreen data={loginData(passkey_available)} />);
}
export function loginWithoutPasswordHash() {
  return renderToString(() => <LoginScreen data={{ ...loginData(true), hash_configured: false, error: "密码错误" }} />);
}
