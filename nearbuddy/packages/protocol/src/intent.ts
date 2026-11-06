// Arena intents and TEE proofs. `Intent` is byte-identical to arena/src/types.rs (borsh, prefixed by
// the domain); an agent signs intents. `TeeProof` carries the NEAR AI Cloud enclave signature the
// contract verifies over `teeText(...)`; the intent's `proof_hash` is `proofHash(request, response)`.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { serialize } from "borsh";
import { type KeyPair, KeyType, PublicKey } from "near-api-js";
import { b64, hex } from "./index.ts";

export const INTENT_DOMAIN = new TextEncoder().encode("nearbuddy-intent-v1");
export const COMMIT_DOMAIN = new TextEncoder().encode("nearbuddy-commit-v1");
export const CONSENT_DOMAIN = new TextEncoder().encode("nearbuddy-duel-v1");
/** proof_hash when the agent is not TEE-backed (stub model, demo keys). */
export const ZERO_PROOF = b64.enc(new Uint8Array(32));

export type Side = "Long" | "Short";
export interface Intent {
  agent_pk: string; // base64, 32 bytes
  duel_id: string; // u64 decimal
  side: Side;
  size_bps: number; // u16, 1..=10000
  nonce: string; // u64 decimal
  expires_at: string; // unix ns decimal
  proof_hash: string; // base64, 32 bytes: sha256(request_hash || response_hash), or ZERO_PROOF
}
export interface SignedIntent {
  intent: Intent;
  signature: string;
}

/** NEAR AI Cloud signature record, re-encoded for the contract. kind 1 = gateway TEE, 2 = model TEE. */
export interface TeeProof {
  kind: 1 | 2;
  request_hash: string; // base64, 32 bytes
  response_hash: string; // base64, 32 bytes
  signer: string; // base64, 32-byte ed25519 signing_address
  signature: string; // base64, 64 bytes
}

const INTENT_SCHEMA = {
  struct: {
    agent_pk: { array: { type: "u8" } },
    duel_id: "u64",
    side: "u8",
    size_bps: "u16",
    nonce: "u64",
    expires_at: "u64",
    proof_hash: { array: { type: "u8" } },
  },
} as const;

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}
const u64le = (v: string | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return new Uint8Array(b);
};
const utf8 = (s: string) => new TextEncoder().encode(s);

export function intentMessage(i: Intent): Uint8Array {
  const body = serialize(INTENT_SCHEMA, {
    agent_pk: b64.dec(i.agent_pk),
    duel_id: BigInt(i.duel_id),
    side: i.side === "Long" ? 0 : 1,
    size_bps: i.size_bps,
    nonce: BigInt(i.nonce),
    expires_at: BigInt(i.expires_at),
    proof_hash: b64.dec(i.proof_hash),
  });
  return concat(INTENT_DOMAIN, body);
}

/** Commit-reveal: sha256(intentMessage(intent) || salt), the 32 bytes `commit_intent` stores. */
export function commitment(i: Intent, salt: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(intentMessage(i)).update(salt).digest());
}

/** Bytes the agent signs for `commit_intent`: domain || contract id || duel_id u64 LE || commitment. */
export function commitMessage(contractId: string, duelId: string, c: Uint8Array): Uint8Array {
  return concat(COMMIT_DOMAIN, utf8(contractId), u64le(duelId), c);
}

/** Bytes each agent signs for `open_duel_consented`: domain || contract id || a || b || symbol || close_at u64 LE. */
export function consentMessage(contractId: string, a: string, b: string, symbol: string, closeAt: string): Uint8Array {
  return concat(CONSENT_DOMAIN, utf8(contractId), b64.dec(a), b64.dec(b), utf8(symbol), u64le(closeAt));
}

/** The exact bytes a NEAR AI Cloud enclave signs (`text` in GET /v1/signature/{chat_id}). */
export function teeText(kind: 1 | 2, modelId: string, requestHash: Uint8Array, responseHash: Uint8Array): Uint8Array {
  const body = `${hex(requestHash)}:${hex(responseHash)}`;
  return new TextEncoder().encode(kind === 1 ? body : `${modelId}:${body}`);
}

/** `Intent.proof_hash` for a TEE-proved decision. */
export function proofHash(requestHash: Uint8Array, responseHash: Uint8Array): string {
  return b64.enc(createHash("sha256").update(requestHash).update(responseHash).digest());
}

export function verify(pkB64: string, msg: Uint8Array, sigB64: string): boolean {
  const pk = b64.dec(pkB64);
  if (pk.length !== 32) return false;
  return new PublicKey({ keyType: KeyType.ED25519, data: pk }).verify(msg, b64.dec(sigB64));
}

// ed25519 from a 32-byte seed with node:crypto only (PKCS8 prefix + seed); pk = last 32 bytes of SPKI.
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
export const keyFromSeed = (hex: string) =>
  createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });
export const pkOf = (k: ReturnType<typeof keyFromSeed>) =>
  b64.enc(new Uint8Array(createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32)));
/** Seed of the enclave agent derived from a plain `AGENT_SEED_*`: sha256(seed || "tee"), as agents/runner.py `agent_key(tee=True)`. */
export const teeSeed = (seedHex: string) =>
  hex(
    createHash("sha256")
      .update(Buffer.concat([Buffer.from(seedHex, "hex"), Buffer.from("tee")]))
      .digest(),
  );

export function signIntent(kp: KeyPair, intent: Intent): SignedIntent {
  return { intent, signature: b64.enc(kp.sign(intentMessage(intent)).signature) };
}
export function verifyIntent(s: SignedIntent): boolean {
  return verify(s.intent.agent_pk, intentMessage(s.intent), s.signature);
}
/** Same check the contract runs: enclave signature over the rebuilt text, and the intent commits to it. */
export function verifyTeeProof(p: TeeProof, modelId: string, intentProofHash: string): boolean {
  const req = b64.dec(p.request_hash),
    res = b64.dec(p.response_hash);
  if (req.length !== 32 || res.length !== 32) return false;
  return verify(p.signer, teeText(p.kind, modelId, req, res), p.signature) && proofHash(req, res) === intentProofHash;
}
