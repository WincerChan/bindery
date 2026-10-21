import { createFileRoute } from "@tanstack/solid-router";
import { createIsomorphicFn } from "@tanstack/solid-start";
import { LoginScreen } from "../features/auth/login-screen";
const getLoginData = createIsomorphicFn().server(async () => (await import("../server/auth-views")).loginData()).client(async () => {
  const response = await fetch("/login/data" + window.location.search, {
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error("无法加载登录信息");
  return response.json() as Promise<{
    hash_configured: boolean;
    next: string;
    error: string | null;
    passkey_available: boolean;
  }>;
});
export const Route = createFileRoute("/login")({
  loader: () => getLoginData(),
  head: () => ({
    meta: [{
      title: "登录 · Bindery"
    }]
  }),
  component: Login
});
function Login() {
  const data = Route.useLoaderData();
  return <LoginScreen data={data()} />;
}
