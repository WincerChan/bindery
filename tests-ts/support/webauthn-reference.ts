import { createHash, createPrivateKey, constants, sign as cryptoSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { BinderyDatabase } from "../../src/server/db";

/**
 * Frozen WebAuthn material recorded from the legacy oracle at the cutover
 * commit. Private keys, COSE public keys and the verified passkey rows were
 * produced by py_webauthn; the signing code below only reproduces the oracle's
 * deterministic WebAuthn messages for challenges generated during the test.
 */
export const ORIGIN = "https://books.example.com";
export const RP_ID = "books.example.com";

interface PasskeyRow {
  credential_id: string;
  public_key: string;
  sign_count: number;
  transports_json: string;
  aaguid: string | null;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}
interface KeyFixture {
  alg: number;
  credential_id: string;
  private_key_pem: string;
  public_key_b64: string;
  passkey: PasskeyRow;
}
interface RegistrationFixture extends Omit<KeyFixture, "passkey"> {
  credential: Record<string, unknown>;
}
interface Reference {
  hashes: Record<string, string>;
  passkeys: KeyFixture[];
  registration: RegistrationFixture;
  challenge: { id: string; challenge_b64: string; kind: string; session_id: string | null };
  session: { session_id: string; created_at: string; last_seen: string; auth_method: string; password_verified_at: string | null };
}
export const authReference = JSON.parse(
  readFileSync(resolve("tests-ts/fixtures/parity/auth/reference.json"), "utf8"),
) as Reference;

const b64url = (data: Uint8Array | Buffer | string) => Buffer.from(data).toString("base64url");
const unb64url = (value: string) => Buffer.from(value, "base64url");
const concat = (...parts: Uint8Array[]) => Buffer.concat(parts.map(part => Buffer.from(part)));
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();
const hashFor = (alg: number) => alg === -7 || alg === -37 || alg === -257 ? "sha256" : alg === -36 || alg === -39 || alg === -259 ? "sha512" : alg === -38 || alg === -258 ? "sha384" : null;
const saltFor = (alg: number) => alg === -37 ? 32 : alg === -38 ? 48 : alg === -39 ? 64 : 0;

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65536) { const out = Buffer.alloc(3); out[0] = (major << 5) | 25; out.writeUInt16BE(length, 1); return out; }
  const out = Buffer.alloc(5); out[0] = (major << 5) | 26; out.writeUInt32BE(length, 1); return out;
}
const cborBytes = (value: Uint8Array) => concat(cborHead(2, value.length), value);
const cborText = (value: string) => { const bytes = Buffer.from(value, "utf8"); return concat(cborHead(3, bytes.length), bytes); };
const cborMap = (entries: [string, Uint8Array][]) => concat(cborHead(5, entries.length), ...entries.flatMap(([key, value]) => [cborText(key), value]));
const emptyMap = Buffer.from([0xa0]);

function clientData(kind: string, challenge: string, config: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({
    type: kind,
    challenge,
    origin: (config.origin as string) || ORIGIN,
    crossOrigin: false,
  }), "utf8");
}
function authenticatorData(rpId: string, flags: number, counter: number, credential?: { id: Uint8Array; cose: Uint8Array }) {
  const out = [sha256(rpId), Buffer.from([flags]), Buffer.alloc(4)];
  out[2].writeUInt32BE(counter, 0);
  if (credential) {
    const length = Buffer.alloc(2); length.writeUInt16BE(credential.id.length, 0);
    out.push(Buffer.alloc(16), length, Buffer.from(credential.id), Buffer.from(credential.cose));
  }
  return concat(...out);
}

export function installPasskey(db: BinderyDatabase, alg: number): KeyFixture & { id: string } {
  const key = authReference.passkeys.find(item => item.alg === alg);
  if (!key) throw new Error(`Missing frozen passkey for COSE ${alg}`);
  db.insertPasskey({
    ...key.passkey,
    public_key: unb64url(key.public_key_b64),
    backed_up: Boolean(key.passkey.backed_up),
  });
  return { ...key, id: key.credential_id };
}

export function registrationCredential(challenge: string, config: Record<string, unknown> = {}, destination?: string) {
  const key = authReference.registration;
  const credentialId = unb64url(key.credential_id), cose = unb64url(key.public_key_b64);
  const data = authenticatorData((config.rp_id as string) || RP_ID, Number(config.flags ?? 0x45), 0, { id: credentialId, cose });
  const attestation = cborMap([
    ["fmt", cborText("none")],
    ["attStmt", emptyMap],
    ["authData", cborBytes(data)],
  ]);
  if (destination) writeFileSync(join(destination, `${key.credential_id}.cose`), cose);
  return {
    id: key.credential_id,
    rawId: key.credential_id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(clientData("webauthn.create", challenge, config)),
      attestationObject: b64url(attestation),
      transports: ["internal", "hybrid", "bogus"],
    },
  };
}

export function assertionCredential(credentialId: string, challenge: string, config: Record<string, unknown> = {}) {
  const key = authReference.passkeys.find(item => item.credential_id === credentialId) ??
    (authReference.registration.credential_id === credentialId ? authReference.registration : undefined);
  if (!key) throw new Error(`Missing frozen WebAuthn key ${credentialId}`);
  const data = authenticatorData((config.rp_id as string) || RP_ID, Number(config.flags ?? 5), Number(config.counter ?? 1));
  const client = clientData("webauthn.get", challenge, config);
  const signed = concat(data, sha256(client));
  const privateKey = createPrivateKey(key.private_key_pem);
  const hash = hashFor(key.alg);
  let signature: Buffer;
  if (hash === null) signature = cryptoSign(null, signed, privateKey);
  else if (key.alg === -7 || key.alg === -36) signature = cryptoSign(hash, signed, { key: privateKey, dsaEncoding: "der" });
  else if (key.alg === -37 || key.alg === -38 || key.alg === -39) signature = cryptoSign(hash, signed, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: saltFor(key.alg) });
  else signature = cryptoSign(hash, signed, { key: privateKey, padding: constants.RSA_PKCS1_PADDING });
  if (config.corrupt) signature[0] ^= 1;
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(client),
      authenticatorData: b64url(data),
      signature: b64url(signature),
      userHandle: null,
    },
  };
}

export async function verifyRecordedAssertion(
  credential: ReturnType<typeof assertionCredential>,
  challenge: string,
  publicKey: Buffer,
  counter: number,
): Promise<{ counter: number }> {
  const verified = await verifyAuthenticationResponse({
    response: credential as never,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: { id: credential.id, publicKey: new Uint8Array(publicKey), counter },
    requireUserVerification: true,
  });
  return { counter: verified.authenticationInfo.newCounter };
}

export function recordedChallenge(db: BinderyDatabase) {
  const challenge = authReference.challenge;
  const bytes = Buffer.from(challenge.challenge_b64, "base64");
  db.run(
    "INSERT INTO webauthn_challenges(id, kind, challenge, session_id, expires_at) VALUES (?, ?, ?, ?, ?)",
    challenge.id,
    challenge.kind,
    bytes,
    challenge.session_id,
    new Date(Date.now() + 300000).toISOString(),
  );
  return { id: challenge.id, challenge: b64url(bytes) };
}
