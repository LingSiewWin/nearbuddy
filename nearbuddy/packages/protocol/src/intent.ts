// Arena intents and resolutions. Byte-identical to `Intent` / `Resolution` in arena/src/types.rs
// (borsh, prefixed by the domain). An agent signs intents; the oracle signs resolutions.
import { serialize } from "borsh";
import { KeyPair, KeyType, PublicKey } from "near-api-js";
import { b64 } from "./index.ts";

export const INTENT_DOMAIN = new TextEncoder().encode("nearbuddy-intent-v1");
export const RESOLVE_DOMAIN = new TextEncoder().encode("nearbuddy-resolve-v1");
/** proof_hash when the decision came from the stub model (no TEE signature). */
export const ZERO_PROOF = b64.enc(new Uint8Array(32));

export type Side = "Long" | "Short";
export interface Intent {
  agent_pk: string;    // base64, 32 bytes
  duel_id: string;     // u64 decimal
  side: Side;
  size_bps: number;    // u16, 1..=10000
  nonce: string;       // u64 decimal
  expires_at: string;  // unix ns decimal
  proof_hash: string;  // base64, 32 bytes: sha256 of the NEAR AI Cloud signature record
}
export interface SignedIntent { intent: Intent; signature: string }
export interface Resolution { duel_id: string; open_price: string; close_price: string } // prices u64, 8 dp

const INTENT_SCHEMA = {
  struct: {
    agent_pk: { array: { type: "u8" } }, duel_id: "u64", side: "u8", size_bps: "u16",
    nonce: "u64", expires_at: "u64", proof_hash: { array: { type: "u8" } },
  },
} as const;
const RESOLVE_SCHEMA = { struct: { duel_id: "u64", open_price: "u64", close_price: "u64" } } as const;

function withDomain(domain: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(domain.length + body.length);
  out.set(domain);
  out.set(body, domain.length);
  return out;
}

export function intentMessage(i: Intent): Uint8Array {
  const body = serialize(INTENT_SCHEMA, {
    agent_pk: b64.dec(i.agent_pk), duel_id: BigInt(i.duel_id), side: i.side === "Long" ? 0 : 1,
    size_bps: i.size_bps, nonce: BigInt(i.nonce), expires_at: BigInt(i.expires_at), proof_hash: b64.dec(i.proof_hash),
  });
  return withDomain(INTENT_DOMAIN, body);
}

export function resolutionMessage(r: Resolution): Uint8Array {
  const body = serialize(RESOLVE_SCHEMA, {
    duel_id: BigInt(r.duel_id), open_price: BigInt(r.open_price), close_price: BigInt(r.close_price),
  });
  return withDomain(RESOLVE_DOMAIN, body);
}

function verify(pkB64: string, msg: Uint8Array, sigB64: string): boolean {
  const pk = b64.dec(pkB64);
  if (pk.length !== 32) return false;
  return new PublicKey({ keyType: KeyType.ED25519, data: pk }).verify(msg, b64.dec(sigB64));
}

export function signIntent(kp: KeyPair, intent: Intent): SignedIntent {
  return { intent, signature: b64.enc(kp.sign(intentMessage(intent)).signature) };
}
export function verifyIntent(s: SignedIntent): boolean {
  return verify(s.intent.agent_pk, intentMessage(s.intent), s.signature);
}
export function signResolution(kp: KeyPair, r: Resolution): string {
  return b64.enc(kp.sign(resolutionMessage(r)).signature);
}
export function verifyResolution(r: Resolution, sigB64: string, oraclePkB64: string): boolean {
  return verify(oraclePkB64, resolutionMessage(r), sigB64);
}
