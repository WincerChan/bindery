import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import { verify } from "@node-rs/argon2";
import { BinderyDatabase, nowIso, type Session } from "./db";
import { awareTimestamp } from "./db/encoding";
import { readEnv } from "./env";
export const SESSION_COOKIE = "bindery_session";
export function configuredHash(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readEnv("BINDERY_PASSWORD_HASH", env);
}
export async function verifyPassword(password: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const stored = configuredHash(env);
  if (!stored) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}
export function signIn(db: BinderyDatabase, method = "password", verifiedAt: string | null = null): string {
  const id = randomBytes(32).toString("base64url"),
    now = nowIso();
  db.createSession(id, now, method, method === "password" && verifiedAt === null ? now : verifiedAt);
  return id;
}
export function isAuthenticated(db: BinderyDatabase, id: string | null | undefined): boolean {
  if (!id || !db.getSession(id)) return false;
  db.touchSession(id, nowIso());
  return true;
}
export function signOut(db: BinderyDatabase, id: string | null | undefined): void {
  if (id) db.deleteSession(id);
}
export function passwordIsFresh(session: Pick<Session, "password_verified_at"> | null, now = Date.now()): boolean {
  const age = now - awareTimestamp(session?.password_verified_at);
  return age >= 0 && age <= 600000;
}
export interface WebauthnConfig {
  origin: string;
  rp_id: string;
  secure: boolean;
}
function dnsHostname(host: string): boolean {
  return host.length <= 253 && !/^(?:[0-9]+|0x[0-9a-f]+)$/.test(host.split(".").at(-1)!) && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
function idna(value: string): string {
  return domainToASCII(value.normalize("NFKC").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ"));
}
export function webauthnConfig(request?: Request, env: NodeJS.ProcessEnv = process.env): WebauthnConfig | null {
  const raw = readEnv("BINDERY_PUBLIC_ORIGIN", env);
  if (!raw) {
    if (request) {
      const url = new URL(request.url);
      if (url.hostname === "localhost") return {
        origin: url.origin,
        rp_id: "localhost",
        secure: url.protocol === "https:"
      };
    }
    return null;
  }
  try {
    if (/[\x00-\x20\x7f\\]/.test(raw) || !/^https?:\/\/[^/?#]+$/i.test(raw)) return null;
    const [, scheme, authority] = /^(https?):\/\/([^/?#]+)$/i.exec(raw)!;
    if (authority!.includes("@") || /[%\[\]]/.test(authority!)) return null;
    const [rawHost, ...portParts] = authority!.split(":");
    if (portParts.length > 1 || portParts[0] && !/^[0-9]+$/.test(portParts[0])) return null;
    const port = portParts[0] ? Number(portParts[0]) : null;
    if (port !== null && port > 65535) return null;
    const protocol = scheme!.toLowerCase(),
      host = idna(rawHost!);
    if (!dnsHostname(host) || protocol !== "https" && host !== "localhost") return null;
    const rp = idna(readEnv("BINDERY_WEBAUTHN_RP_ID", env) || host);
    if (!dnsHostname(rp) || rp !== host && (!rp.includes(".") || !host.endsWith(`.${rp}`))) return null;
    return {
      origin: `${protocol}://${host}${port !== null && port !== (protocol === "https" ? 443 : 80) ? `:${port}` : ""}`,
      rp_id: rp,
      secure: protocol === "https"
    };
  } catch {
    return null;
  }
}
export function safeNext(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") && !/[\x00-\x1f\x7f-\x9f]/.test(value) ? value : "/";
}
