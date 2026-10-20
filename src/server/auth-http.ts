import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { BinderyDatabase, nowIso, type Challenge, type Passkey } from "./db";
import { awareTimestamp, pythonJson } from "./db/encoding";
import { strip } from "../core/python";
import { configuredHash, isAuthenticated, passwordIsFresh, safeNext, SESSION_COOKIE, signIn, signOut, verifyPassword, webauthnConfig, type WebauthnConfig } from "./auth";
export const WEBAUTHN_COOKIE = "bindery_webauthn";
const LOGIN_PATH = "/login/passkey",
  REGISTER_PATH = "/security/passkeys";
const TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "cable", "smart-card"]);
// py_webauthn's registration defaults, including existing RSA/P-521 credentials.
const ALGORITHMS = [-7, -8, -36, -37, -38, -39, -257, -258, -259];
export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
export function cookies(request: Request): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    result[part.slice(0, at).trim()] = part.slice(at + 1).trim().replace(/^"|"$/g, "");
  }
  return result;
}
function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax`;
}
function challengeCookie(value: string, kind: string, config: WebauthnConfig | null, clear = false): string {
  return `${WEBAUTHN_COOKIE}=${value}; Max-Age=${clear ? 0 : 300}; Path=${kind === "login" ? LOGIN_PATH : REGISTER_PATH}; HttpOnly; SameSite=Strict${config?.secure ? "; Secure" : ""}${clear ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : ""}`;
}
export function publicPasskey(key: Passkey) {
  const {
    credential_id,
    name,
    device_type,
    backed_up,
    created_at,
    last_used_at
  } = key;
  return {
    credential_id,
    name,
    device_type,
    backed_up,
    created_at,
    last_used_at
  };
}
export function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location
    }
  });
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status
  });
}
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new AuthError("请使用 application/json", 415);
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", {
      fatal: true
    }).decode(await request.arrayBuffer()));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new AuthError("请求格式错误");
  }
}
function configFor(request: Request): WebauthnConfig {
  const config = webauthnConfig(request);
  if (!config) throw new AuthError("通行密钥不可用", 404);
  return config;
}
function nameFor(value: unknown, db: BinderyDatabase): string {
  if (typeof value !== "string") throw new AuthError("名称格式错误");
  return [...strip(value)].slice(0, 40).join("") || `通行密钥 ${db.countPasskeys() + 1}`;
}
function consume(request: Request, db: BinderyDatabase, kind: string): Challenge | null {
  const jar = cookies(request),
    challenge = db.popChallenge(jar[WEBAUTHN_COOKIE] || "");
  if (!challenge || challenge.kind !== kind || !(awareTimestamp(challenge.expires_at) > Date.now()) || kind === "register" && challenge.session_id !== jar[SESSION_COOKIE]) return null;
  return challenge;
}
function issue(options: {
  challenge: string;
}, kind: "login" | "register", request: Request, db: BinderyDatabase, config: WebauthnConfig): Response {
  const id = db.createChallenge(kind, Buffer.from(options.challenge, "base64url"), kind === "register" ? cookies(request)[SESSION_COOKIE]! : null);
  const response = json(options);
  response.headers.append("Set-Cookie", challengeCookie(id, kind, config));
  return response;
}

// Shared by the production entry and direct Request/Response tests. Returns null
// for authenticated routes or RPCs (globally authenticated by src/start.ts).
// All state stays in SQLite.
export async function handleAuthRequest(request: Request, db: BinderyDatabase): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname,
    jar = cookies(request);
  if (!path.startsWith("/login") && !isAuthenticated(db, jar[SESSION_COOKIE])) {
    // Use the same build-defined base and prefix match as Start's handler.
    // Both GET data RPCs and POST actions must reach its redirect serializer;
    // src/start.ts applies authentication to every server function by default.
    const serverFnBase = process.env.TSS_SERVER_FN_BASE;
    if (serverFnBase && path.startsWith(serverFnBase)) return null;
    const location = `/login?next=${path}`;
    return request.headers.get("HX-Request") === "true" ? new Response("", {
      status: 401,
      headers: {
        "HX-Redirect": location
      }
    }) : redirect(location);
  }
  if (request.method === "GET" && path === "/login/data") return json((await import("./auth-views")).loginData(request, db));
  if (request.method !== "POST") return null;
  try {
    if (path === "/login") {
      if (!configuredHash()) return redirect("/login?error=" + encodeURIComponent("未配置密码哈希"));
      const contentType = request.headers.get("content-type")?.split(";", 1)[0];
      let form = new FormData();
      if (contentType === "application/x-www-form-urlencoded" || contentType === "multipart/form-data") {
        try {
          form = await request.formData();
        } catch {
          throw new AuthError("请求格式错误");
        }
      }
      const password = form.get("password");
      if (typeof password !== "string" || !(await verifyPassword(password))) return redirect("/login?error=" + encodeURIComponent("密码错误"));
      const response = redirect(safeNext(form.get("next")));
      response.headers.append("Set-Cookie", sessionCookie(signIn(db)));
      return response;
    }
    if (path === "/logout") {
      signOut(db, jar[SESSION_COOKIE]);
      const response = redirect("/login");
      response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`);
      return response;
    }
    if (path === `${LOGIN_PATH}/options`) {
      await jsonBody(request);
      const config = configFor(request);
      if (!db.countPasskeys()) throw new AuthError("通行密钥不可用", 404);
      return issue(await generateAuthenticationOptions({
        rpID: config.rp_id,
        userVerification: "required",
        allowCredentials: []
      }), "login", request, db, config);
    }
    if (path === `${LOGIN_PATH}/verify`) {
      const challenge = consume(request, db, "login");
      let body: Record<string, unknown>;
      try {
        body = await jsonBody(request);
      } catch (e) {
        if (e instanceof AuthError && e.status === 415) throw e;
        throw new AuthError("通行密钥验证失败");
      }
      const config = configFor(request);
      let key: Passkey, verified;
      try {
        if (!challenge) throw new Error();
        const credential = body.credential as AuthenticationResponseJSON;
        const found = db.getPasskey(credential.rawId);
        if (!found) throw new Error();
        key = found;
        verified = await verifyAuthenticationResponse({
          response: credential,
          expectedChallenge: Buffer.from(challenge.challenge).toString("base64url"),
          expectedOrigin: config.origin,
          expectedRPID: config.rp_id,
          credential: {
            id: key.credential_id,
            publicKey: new Uint8Array(key.public_key),
            counter: key.sign_count
          },
          requireUserVerification: true
        });
        if (!verified.verified) throw new Error();
      } catch {
        throw new AuthError("通行密钥验证失败");
      }
      // WebCrypto yields while verifying. Recheck the counter atomically so two
      // independent challenges cannot roll it back, or revive a deleted key.
      const counter = verified.authenticationInfo.newCounter;
      const updated = db.run(`UPDATE passkeys SET sign_count = ?, backed_up = ?, last_used_at = ?
        WHERE credential_id = ? AND ((sign_count = 0 AND ? = 0) OR sign_count < ?)`, counter, Number(verified.authenticationInfo.credentialBackedUp), nowIso(), key.credential_id, counter, counter);
      if (!updated) throw new AuthError("通行密钥验证失败");
      const response = json({
        redirect: safeNext(body.next)
      });
      response.headers.append("Set-Cookie", sessionCookie(signIn(db, "passkey")));
      response.headers.append("Set-Cookie", challengeCookie("", "login", config, true));
      return response;
    }
    if (path === "/security/reauth") {
      const body = await jsonBody(request);
      configFor(request);
      if (!configuredHash()) throw new AuthError("未配置密码哈希");
      if (typeof body.password !== "string" || !(await verifyPassword(body.password))) throw new AuthError("密码错误");
      db.markPasswordVerified(jar[SESSION_COOKIE]!, nowIso());
      return json({
        ok: true
      });
    }
    if (path === `${REGISTER_PATH}/register/options`) {
      await jsonBody(request);
      const config = configFor(request);
      if (!passwordIsFresh(db.getSession(jar[SESSION_COOKIE]!))) throw new AuthError("needs_password", 403);
      const options = await generateRegistrationOptions({
        rpID: config.rp_id,
        rpName: "Bindery",
        userID: db.getOrCreateWebauthnUserId(),
        userName: "bindery",
        userDisplayName: "Bindery",
        attestationType: "none",
        supportedAlgorithmIDs: ALGORITHMS,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required"
        },
        excludeCredentials: db.listPasskeys().map(key => ({
          id: key.credential_id,
          transports: JSON.parse(key.transports_json) as string[]
        }))
      });
      return issue(options, "register", request, db, config);
    }
    if (path === `${REGISTER_PATH}/register/verify`) {
      const challenge = consume(request, db, "register"),
        body = await jsonBody(request),
        config = configFor(request);
      if (!challenge) throw new AuthError("通行密钥验证失败");
      if (!passwordIsFresh(db.getSession(jar[SESSION_COOKIE]!))) throw new AuthError("needs_password", 403);
      const name = nameFor("name" in body ? body.name : "", db);
      let info, transports: string[];
      try {
        const credential = body.credential as RegistrationResponseJSON;
        const verified = await verifyRegistrationResponse({
          response: credential,
          expectedChallenge: Buffer.from(challenge.challenge).toString("base64url"),
          expectedOrigin: config.origin,
          expectedRPID: config.rp_id,
          requireUserVerification: true,
          supportedAlgorithmIDs: ALGORITHMS
        });
        if (!verified.verified) throw new Error();
        info = verified.registrationInfo;
        transports = (credential.response.transports || []).filter(t => TRANSPORTS.has(t));
      } catch {
        throw new AuthError("通行密钥验证失败");
      }
      try {
        // Registration verification also yields to other requests (e.g. logout).
        if (!passwordIsFresh(db.getSession(jar[SESSION_COOKIE]!))) throw new AuthError("needs_password", 403);
        db.insertPasskey({
          credential_id: info.credential.id,
          public_key: info.credential.publicKey,
          sign_count: info.credential.counter,
          transports_json: pythonJson(transports),
          aaguid: info.aaguid,
          device_type: info.credentialDeviceType === "multiDevice" ? "multi_device" : "single_device",
          backed_up: info.credentialBackedUp,
          name,
          created_at: nowIso()
        });
      } catch (e) {
        if ((e as {
          errcode?: number;
        }).errcode === 1555 || (e as {
          errcode?: number;
        }).errcode === 2067) throw new AuthError("此通行密钥已添加", 409);
        throw e;
      }
      const response = json({
        ok: true,
        passkey: publicPasskey(db.getPasskey(info.credential.id)!)
      });
      response.headers.append("Set-Cookie", challengeCookie("", "register", config, true));
      return response;
    }
    const action = /^\/security\/passkeys\/([^/]+)\/(rename|delete)$/.exec(path);
    if (action) {
      const id = decodeURIComponent(action[1]!);
      if (action[2] === "rename") {
        const body = await jsonBody(request);
        configFor(request);
        const name = nameFor("name" in body ? body.name : "", db);
        if (!db.renamePasskey(id, name)) throw new AuthError("通行密钥不存在", 404);
        return json({
          ok: true,
          name
        });
      }
      configFor(request);
      if (!db.deletePasskey(id)) throw new AuthError("通行密钥不存在", 404);
      return redirect("/security?toast=" + encodeURIComponent("已删除通行密钥"));
    }
    return null;
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    const response = json({
      error: error.message
    }, error.status);
    if (path.endsWith("/verify")) response.headers.append("Set-Cookie", challengeCookie("", path.startsWith("/login/") ? "login" : "register", webauthnConfig(request), true));
    return response;
  }
}
