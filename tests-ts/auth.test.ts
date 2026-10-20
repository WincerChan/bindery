import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { randomBytes } from "node:crypto";
import { BinderyDatabase, nowIso } from "../src/server/db";
import { isAuthenticated, passwordIsFresh, safeNext, SESSION_COOKIE, signIn, verifyPassword, webauthnConfig } from "../src/server/auth";
import { handleAuthRequest, WEBAUTHN_COOKIE } from "../src/server/auth-http";
const root = mkdtempSync(join(tmpdir(), "bindery-auth-")),
  exec = promisify(execFile);
afterAll(() => rmSync(root, {
  recursive: true,
  force: true
}));
const origin = "https://books.example.com";
let path: string, db: BinderyDatabase, hashes: Record<string, string>;
async function python(mode: string, ...args: string[]) {
  const {
    stdout
  } = await exec("uv", ["run", "--no-sync", "python", "scripts/parity/auth-reference.py", mode, path || root, ...args], {
    maxBuffer: 2 * 1024 * 1024
  });
  return JSON.parse(stdout);
}
beforeAll(async () => {
  hashes = await python("hashes");
});
beforeEach(() => {
  path = mkdtempSync(join(root, "case-"));
  db = new BinderyDatabase(join(path, "data.db"));
  db.init();
  for (const name of ["BINDERY_PASSWORD_HASH", "BINDERY_PUBLIC_ORIGIN", "BINDERY_WEBAUTHN_RP_ID", "BINDERY_DB_PATH", "BINDERY_LIBRARY_DIR"]) vi.stubEnv(`${name}_FILE`, "");
  vi.stubEnv("BINDERY_PASSWORD_HASH", hashes.ID!);
  vi.stubEnv("BINDERY_PUBLIC_ORIGIN", origin);
  vi.stubEnv("BINDERY_WEBAUTHN_RP_ID", "");
  vi.stubEnv("BINDERY_DB_PATH", db.path);
  vi.stubEnv("BINDERY_LIBRARY_DIR", join(path, "library"));
});
afterEach(() => vi.unstubAllEnvs());
async function request(url: string, body: unknown = {}, jar = "", headers: Record<string, string> = {}): Promise<Response> {
  const response = await handleAuthRequest(new Request(origin + url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: jar,
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  }), db);
  if (!response) throw new Error(`Unhandled ${url}`);
  return response;
}
function cookie(response: Response, name: string): string {
  return response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(";", 1)[0] || "";
}
async function passwordLogin(next = "/"): Promise<Response> {
  return request("/login", new URLSearchParams({
    password: "兼容-password😀",
    next
  }).toString(), "", {
    "Content-Type": "application/x-www-form-urlencoded"
  });
}
async function enroll(alg = -7) {
  return python("enroll-python", String(alg), randomBytes(32).toString("base64url"));
}
async function loginOptions() {
  const response = await request("/login/passkey/options");
  expect(response.status).toBe(200);
  return {
    options: await response.json(),
    jar: cookie(response, WEBAUTHN_COOKIE),
    response
  };
}
async function registrationOptions(session: string) {
  const response = await request("/security/passkeys/register/options", {}, session);
  expect(response.status).toBe(200);
  return {
    options: await response.json(),
    jar: `${session}; ${cookie(response, WEBAUTHN_COOKIE)}`,
    response
  };
}
describe("password and session compatibility", () => {
  it("verifies Python Argon2id/i/d PHC hashes, wrong passwords and malformed/missing hashes", async () => {
    for (const value of Object.values(hashes)) {
      const env = {
        BINDERY_PASSWORD_HASH: value
      };
      expect(await verifyPassword("兼容-password😀", env)).toBe(true);
      expect(await verifyPassword("wrong", env)).toBe(false);
    }
    expect(await verifyPassword("x", {})).toBe(false);
    expect(await verifyPassword("x", {
      BINDERY_PASSWORD_HASH: "invalid"
    })).toBe(false);
    const file = join(path, "hash");
    writeFileSync(file, hashes.ID + "\r\n");
    expect(await verifyPassword("兼容-password😀", {
      BINDERY_PASSWORD_HASH_FILE: file
    })).toBe(true);
  });
  it("preserves password/passkey session metadata and reciprocal Python sessions", async () => {
    const response = await passwordLogin("/?q=a:b");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?q=a:b");
    const setCookie = cookie(response, SESSION_COOKIE),
      id = setCookie.split("=")[1]!;
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).not.toContain("Max-Age");
    expect(db.getSession(id)?.auth_method).toBe("password");
    expect(passwordIsFresh(db.getSession(id))).toBe(true);
    expect(await python("check-session", id)).toEqual({
      authenticated: true
    });
    const existing = await python("session");
    expect(isAuthenticated(db, existing.session)).toBe(true);
    const passkeyId = signIn(db, "passkey");
    expect(db.getSession(passkeyId)?.password_verified_at).toBeNull();
    const logout = await request("/logout", {}, setCookie);
    expect(logout.status).toBe(303);
    expect(db.getSession(id)).toBeNull();
  });
  it.each(["/security", "/", "/_serverFn/data/secret", "/book/%E4%B8%AD"])("protects %s and preserves HTMX authentication behavior without a configured RPC base", async url => {
    vi.stubEnv("TSS_SERVER_FN_BASE", "");
    const req = new Request(origin + url);
    expect((await handleAuthRequest(req, db))?.status).toBe(303);
    const htmx = await handleAuthRequest(new Request(origin + url, {
      headers: {
        "HX-Request": "true"
      }
    }), db);
    expect(htmx?.status).toBe(401);
    expect(htmx?.headers.get("HX-Redirect")).toBe(`/login?next=${url}`);
  });
  it("rejects unsafe redirects and future/naive/expired reauthentication timestamps", async () => {
    for (const value of ["//evil.com", "https://evil.com", "/\\evil.com", "/\nhello", "/\x7fhello", "", null]) expect(safeNext(value)).toBe("/");
    for (const value of ["/?q=a:b", "/book/a?next=https://evil.com", "/book/a?return_to=%2F"]) expect(safeNext(value)).toBe(value);
    for (const value of [null, "invalid", "2026-01-01", "2026-10-19T00:00:00", nowIso(new Date(Date.now() + 60000)), nowIso(new Date(Date.now() - 600001))]) expect(passwordIsFresh({
      password_verified_at: value
    })).toBe(false);
    expect((await passwordLogin("//evil.com")).headers.get("location")).toBe("/");
    vi.stubEnv("BINDERY_PASSWORD_HASH", "");
    expect((await passwordLogin()).headers.get("location")).toContain(encodeURIComponent("未配置密码哈希"));
  });
});
describe("Start RPC entrance boundary", () => {
  it.each(["GET", "POST"])("hands %s RPCs to Start using its configured base, including HX requests", async method => {
    vi.stubEnv("TSS_SERVER_FN_BASE", "/configured-rpc/");
    for (const suffix of ["data/secret", "secret"]) for (const headers of [new Headers(), new Headers({ "HX-Request": "true" })]) {
      expect(await handleAuthRequest(new Request(origin + "/configured-rpc/" + suffix, { method, headers }), db)).toBeNull();
    }
  });
  it.each(["/configured-rpc", "/configured-rpc-other/secret", "/tracker/duplicate-check", "/assets/private.js", "/"])("keeps the entrance gate for %s", async path => {
    vi.stubEnv("TSS_SERVER_FN_BASE", "/configured-rpc/");
    for (const method of ["GET", "POST"]) {
      const response = await handleAuthRequest(new Request(origin + path, { method }), db);
      expect(response?.status).toBe(303);
      expect(response?.headers.get("Location")).toBe(`/login?next=${path}`);
      const hx = await handleAuthRequest(new Request(origin + path, { method, headers: { "HX-Request": "true" } }), db);
      expect(hx?.status).toBe(401);
      expect(hx?.headers.get("HX-Redirect")).toBe(`/login?next=${path}`);
    }
  });
  it.each([undefined, ""])("fails closed when the RPC base is %s", async base => {
    vi.stubEnv("TSS_SERVER_FN_BASE", base);
    for (const method of ["GET", "POST"]) {
      expect((await handleAuthRequest(new Request(origin + "/_serverFn/data/secret", { method }), db))?.status).toBe(303);
    }
  });
});
describe("WebAuthn origin/RP resolution", () => {
  it.each([["https://books.example.com", true], ["HTTPS://BOOKS.EXAMPLE.COM:443", true], ["http://localhost:5670", true], ["http://books.example.com", false], ["https://127.0.0.1", false], ["https://2130706433", false], ["https://127.1", false], ["https://0x7f000001", false], ["https://books.example.com/", false], ["https://user@books.example.com", false], ["https://books.example.com?x=1", false], ["https://books.example.com#", false], ["https://books.example.com:bad", false], ["https://books.example.com\n", false], ["https://books.example.com\\evil", false]])("resolves %s", (value, available) => {
    expect(Boolean(webauthnConfig(undefined, {
      BINDERY_PUBLIC_ORIGIN: value as string
    }))).toBe(available);
  });
  it("supports parent RP IDs, _FILE variants and localhost-only fallback", () => {
    for (const [rp, available] of [["example.com", true], ["books.example.com", true], ["com", false], ["evil.com", false], ["127.0.0.1", false], ["example.com:443", false]] as const) expect(Boolean(webauthnConfig(undefined, {
      BINDERY_PUBLIC_ORIGIN: origin,
      BINDERY_WEBAUTHN_RP_ID: rp
    }))).toBe(available);
    expect(webauthnConfig(new Request("http://localhost:5670"), {})?.origin).toBe("http://localhost:5670");
    expect(webauthnConfig(new Request("http://127.0.0.1:5670"), {})).toBeNull();
    expect(webauthnConfig(new Request(origin), {})).toBeNull();
    const file = join(path, "origin");
    writeFileSync(file, origin + "\n");
    expect(webauthnConfig(undefined, {
      BINDERY_PUBLIC_ORIGIN_FILE: file
    })?.origin).toBe(origin);
    expect(webauthnConfig(undefined, {
      BINDERY_PUBLIC_ORIGIN: "https://faß.de"
    })?.origin).toBe("https://fass.de");
    expect(webauthnConfig(undefined, {
      BINDERY_PUBLIC_ORIGIN: "https://%62ooks.example.com"
    })).toBeNull();
  });
});
describe("real WebAuthn signatures and Python-stored credentials", () => {
  it.each([-7, -8, -36, -37, -38, -39, -257, -258, -259])("logs in using a Python-verified/stored credential (COSE %i)", async alg => {
    const key = await enroll(alg),
      {
        options,
        jar,
        response
      } = await loginOptions();
    expect(options.userVerification).toBe("required");
    expect(options.allowCredentials).toEqual([]);
    for (const attr of ["HttpOnly", "Max-Age=300", "Path=/login/passkey", "SameSite=Strict", "Secure"]) expect(response.headers.get("set-cookie")).toContain(attr);
    const credential = await python("assertion", key.id, options.challenge, JSON.stringify({
      counter: 3
    }));
    const verified = await request("/login/passkey/verify", {
      credential,
      next: "/book/a"
    }, jar);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({
      redirect: "/book/a"
    });
    expect(db.getPasskey(key.id)?.sign_count).toBe(3);
    const id = cookie(verified, SESSION_COOKIE).split("=")[1]!;
    expect(db.getSession(id)?.auth_method).toBe("passkey");
    expect(db.getSession(id)?.password_verified_at).toBeNull();
    expect((await request("/login/passkey/verify", {
      credential
    }, jar)).status).toBe(400);
  });
  it("consumes a Python-issued challenge and allows Python to use a TS-registered public key", async () => {
    const session = cookie(await passwordLogin(), SESSION_COOKIE),
      {
        options,
        jar
      } = await registrationOptions(session);
    expect(options.authenticatorSelection.residentKey).toBe("required");
    expect(options.authenticatorSelection.userVerification).toBe("required");
    expect(options.attestation).toBe("none");
    expect(options.user.id).toBe(Buffer.from(db.getOrCreateWebauthnUserId()).toString("base64url"));
    const credential = await python("registration", "-7", options.challenge, JSON.stringify({
      flags: 0x5d
    }));
    const registered = await request("/security/passkeys/register/verify", {
      credential,
      name: "  " + "😀".repeat(45)
    }, jar);
    expect(registered.status).toBe(200);
    const key = (await registered.json()).passkey;
    expect(key.name).toBe("😀".repeat(40));
    expect(key.device_type).toBe("multi_device");
    expect(key.backed_up).toBe(1);
    expect(key).not.toHaveProperty("public_key");
    expect(Buffer.from(db.getPasskey(credential.id)!.public_key)).toEqual(readFileSync(join(path, `${credential.id}.cose`)));
    expect(db.getPasskey(credential.id)?.transports_json).toBe('["internal", "hybrid"]');
    const challenge = randomBytes(32).toString("base64url"),
      assertion = await python("assertion", credential.id, challenge, JSON.stringify({
        counter: 1,
        flags: 0x1d
      }));
    const bodyFile = join(path, "verify.json");
    writeFileSync(bodyFile, JSON.stringify({
      credential: assertion,
      challenge
    }));
    expect(await python("verify", bodyFile)).toEqual({
      counter: 1
    });
    const existing = await python("challenge");
    const nextAssertion = await python("assertion", credential.id, existing.challenge, JSON.stringify({
      counter: 2,
      flags: 0x1d
    }));
    const login = await request("/login/passkey/verify", {
      credential: nextAssertion
    }, `${WEBAUTHN_COOKIE}=${existing.id}`);
    expect(login.status).toBe(200);
  });
  it("keeps the highest counter when independent authentication verifications overlap", async () => {
    const key = await enroll(),
      first = await loginOptions(),
      second = await loginOptions();
    const one = await python("assertion", key.id, first.options.challenge, JSON.stringify({
      counter: 2
    }));
    const two = await python("assertion", key.id, second.options.challenge, JSON.stringify({
      counter: 3
    }));
    const responses = await Promise.all([request("/login/passkey/verify", {
      credential: one
    }, first.jar), request("/login/passkey/verify", {
      credential: two
    }, second.jar)]);
    expect(responses[1]!.status).toBe(200);
    expect([200, 400]).toContain(responses[0]!.status);
    expect(db.getPasskey(key.id)?.sign_count).toBe(3);
  });
  it.each([["wrong origin", {
    origin: "https://evil.com"
  }], ["wrong RP", {
    rp_id: "evil.com"
  }], ["missing UV", {
    flags: 1
  }], ["missing UP", {
    flags: 4
  }], ["corrupt signature", {
    corrupt: true
  }], ["counter replay", {
    counter: 0
  }]])("rejects %s and consumes the challenge", async (_, config) => {
    const key = await enroll();
    db.updatePasskeyUsage(key.id, 1, false, nowIso());
    const {
      options,
      jar
    } = await loginOptions();
    const credential = await python("assertion", key.id, options.challenge, JSON.stringify({
      counter: 2,
      ...(config as object)
    }));
    const response = await request("/login/passkey/verify", {
      credential
    }, jar);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "通行密钥验证失败"
    });
    expect(db.popChallenge(jar.split("=")[1]!)).toBeNull();
    expect(db.getPasskey(key.id)?.sign_count).toBe(1);
  });
  it("requires reauthentication on options and verification, and binds registration to its session", async () => {
    const sessionId = signIn(db, "passkey"),
      session = `${SESSION_COOKIE}=${sessionId}`;
    expect((await request("/security/passkeys/register/options", {}, session)).status).toBe(403);
    expect((await request("/security/reauth", {
      password: "wrong"
    }, session)).status).toBe(400);
    expect((await request("/security/reauth", {
      password: "兼容-password😀"
    }, session)).status).toBe(200);
    let challenge = await registrationOptions(session);
    db.markPasswordVerified(sessionId, nowIso(new Date(Date.now() - 660000)));
    const credential = await python("registration", "-7", challenge.options.challenge);
    expect((await request("/security/passkeys/register/verify", {
      credential
    }, challenge.jar)).status).toBe(403);
    db.markPasswordVerified(sessionId, nowIso());
    challenge = await registrationOptions(session);
    const other = signIn(db),
      challengeCookie = challenge.jar.split("; ")[1];
    expect((await request("/security/passkeys/register/verify", {
      credential
    }, `${SESSION_COOKIE}=${other}; ${challengeCookie}`)).status).toBe(400);
    expect(db.countPasskeys()).toBe(0);
  });
  it("clears and consumes verification challenges on malformed JSON, wrong content type, kind, expiry and unknown credential", async () => {
    await enroll();
    for (const failure of ["malformed", "non-json", "wrong-kind", "expired", "unknown", "missing"]) {
      const {
          jar
        } = await loginOptions(),
        id = jar.split("=")[1]!;
      if (failure === "wrong-kind") db.run("UPDATE webauthn_challenges SET kind='register' WHERE id=?", id);
      if (failure === "expired") db.run("UPDATE webauthn_challenges SET expires_at=? WHERE id=?", nowIso(new Date(Date.now() - 1000)), id);
      const response = await request("/login/passkey/verify", failure === "malformed" ? "{" : {
        credential: {
          rawId: "unknown"
        }
      }, failure === "missing" ? "" : jar, failure === "non-json" ? {
        "Content-Type": "text/plain"
      } : {});
      expect(response.status).toBe(failure === "non-json" ? 415 : 400);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      if (failure !== "missing") expect(db.popChallenge(id)).toBeNull();
    }
  });
  it("registers a default name, reports duplicates, and supports rename/delete with a stale authenticated session", async () => {
    const session = cookie(await passwordLogin(), SESSION_COOKIE);
    let challenge = await registrationOptions(session),
      credential = await python("registration", "-7", challenge.options.challenge);
    expect((await request("/security/passkeys/register/verify", {
      credential
    }, challenge.jar)).status).toBe(200);
    expect(db.getPasskey(credential.id)?.name).toBe("通行密钥 1");
    // A second valid registration of this same authenticator ID has a new challenge.
    challenge = await registrationOptions(session);
    credential.response.clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.create",
      challenge: challenge.options.challenge,
      origin,
      crossOrigin: false
    })).toString("base64url");
    expect((await request("/security/passkeys/register/verify", {
      credential
    }, challenge.jar)).status).toBe(409);
    db.markPasswordVerified(session.split("=")[1]!, nowIso(new Date(Date.now() - 660000)));
    for (const name of [null, 42, {}, []]) {
      expect((await request(`/security/passkeys/${credential.id}/rename`, { name }, session)).status).toBe(400);
    }
    expect(await (await request(`/security/passkeys/${credential.id}/rename`, {
      name: "  新名字  "
    }, session)).json()).toEqual({
      ok: true,
      name: "新名字"
    });
    expect((await request(`/security/passkeys/${credential.id}/delete`, {}, session)).status).toBe(303);
    expect(db.countPasskeys()).toBe(0);
    expect((await request(`/security/passkeys/${credential.id}/delete`, {}, session)).status).toBe(404);
  });
  it("enforces JSON on every JSON endpoint and honors unavailable config", async () => {
    const session = cookie(await passwordLogin(), SESSION_COOKIE);
    for (const endpoint of ["/login/passkey/options", "/login/passkey/verify", "/security/reauth", "/security/passkeys/register/options", "/security/passkeys/register/verify", "/security/passkeys/missing/rename"]) expect((await request(endpoint, "{}", session, {
      "Content-Type": "text/plain"
    })).status).toBe(415);
    expect((await request("/security/reauth", [], session)).status).toBe(400);
    vi.stubEnv("BINDERY_PUBLIC_ORIGIN", "");
    for (const endpoint of ["/login/passkey/options", "/login/passkey/verify", "/security/reauth", "/security/passkeys/register/options", "/security/passkeys/register/verify", "/security/passkeys/missing/rename", "/security/passkeys/missing/delete"]) expect((await request(endpoint, {}, session)).status).toBe(404);
  });
  it("purges expired challenges, preserves the user ID, and consumes atomically across SQLite connections", async () => {
    const old = db.createChallenge("login", new Uint8Array([1]), null, new Date(Date.now() - 360000));
    const id = db.createChallenge("register", new Uint8Array([2]), "session");
    expect(db.popChallenge(old)).toBeNull();
    const userId = db.getOrCreateWebauthnUserId();
    db.init();
    expect(db.getOrCreateWebauthnUserId()).toEqual(userId);
    expect(db.getSetting("webauthn_user_id")).toBe(Buffer.from(userId).toString("base64url"));
    db.setSetting("test", "中文");
    expect(db.getSetting("test")).toBe("中文");
    const results = await Promise.all(Array.from({
      length: 4
    }, () => new Promise<boolean>((resolve, reject) => {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData.path,{timeout:5000}); const row=db.prepare('DELETE FROM webauthn_challenges WHERE id=? RETURNING *').get(workerData.id); db.close(); parentPort.postMessage(!!row);`, {
        eval: true,
        workerData: {
          path: db.path,
          id
        }
      });
      worker.once("message", resolve);
      worker.once("error", reject);
    })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(() => db.createChallenge("register", new Uint8Array())).toThrow();
  });
});
