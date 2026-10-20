import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deletePasskey, postJson } from "../src/client/passkeys";

beforeEach(() => vi.stubGlobal("location", { href: "http://localhost/security?q=one#ignored", pathname: "/security", search: "?q=one", assign: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it.each([401, 303, 200])("sends an expired JSON request (%s) to login before trying to parse HTML", async status => {
  const response = new Response("<html>login</html>", { status, headers: status === 303 ? { Location: "/login" } : {} });
  if (status === 200) Object.defineProperties(response, { redirected: { value: true }, url: { value: "http://localhost/login?next=old" } });
  vi.stubGlobal("fetch", vi.fn(async () => response));
  await expect(postJson("/security/passkeys/register/options")).rejects.toMatchObject({ code: "login", target: "/login?next=%2Fsecurity%3Fq%3Done" });
  expect(location.assign).not.toHaveBeenCalled();
});
it("preserves login verification errors instead of treating them as expired security sessions", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "通行密钥验证失败" }, { status: 401 })));
  await expect(postJson("/login/passkey/verify", {})).rejects.toMatchObject({ message: "通行密钥验证失败", code: "server" });
  expect(location.assign).not.toHaveBeenCalled();
});
it("recognizes browser opaque manual redirects as delete success without loading HTML", async () => {
  const response = new Response(null); Object.defineProperty(response, "type", { value: "opaqueredirect" });
  const fetch = vi.fn(async () => response); vi.stubGlobal("fetch", fetch);
  await expect(deletePasskey("key/id")).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/security/passkeys/key%2Fid/delete", { method: "POST", credentials: "same-origin", redirect: "manual", headers: { "HX-Request": "true" } });
  expect(location.assign).not.toHaveBeenCalled();
});
it("distinguishes a visible expired-session 401 from an opaque success redirect", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401, headers: { "HX-Redirect": "/login?next=old" } })));
  await expect(deletePasskey("key")).rejects.toMatchObject({ code: "login", target: "/login?next=%2Fsecurity%3Fq%3Done" });
  expect(location.assign).not.toHaveBeenCalled();
});
it("does not treat a manual login 303 as successful deletion", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 303, headers: { Location: "/login" } })));
  await expect(deletePasskey("key")).rejects.toMatchObject({ code: "login", target: "/login?next=%2Fsecurity%3Fq%3Done" });
  expect(location.assign).not.toHaveBeenCalled();
});
