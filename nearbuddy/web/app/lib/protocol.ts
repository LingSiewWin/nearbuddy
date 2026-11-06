// The slice of packages/protocol the duel verifier needs (Vercel builds web/ alone, so web cannot import it):
// intent bytes, the enclave's signed text, proof_hash and ed25519 verify. Same outputs as
// packages/protocol/src/intent.ts and index.ts; web/app/__tests__/verify.test.ts checks them against it on real
// intents. Server only (node:crypto, Buffer). The intent body is borsh written by hand: borsh is not a web dependency.
import { createHash } from "node:crypto";
import { KeyType, PublicKey } from "near-api-js";

export const b64 = {
  enc: (b: Uint8Array) => Buffer.from(b).toString("base64"),
  dec: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
};
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export type Side = "Long" | "Short";
export interface Intent {
  agent_pk: string; // base64, 32 bytes
  duel_id: string; // u64 decimal
  side: Side;
  size_bps: number; // u16, 1..=10000
  nonce: string; // u64 decimal
  expires_at: string; // unix ns decimal
  proof_hash: string; // base64, 32 bytes
}
/** NEAR AI Cloud signature record, re-encoded for the contract. kind 1 = gateway TEE, 2 = model TEE. */
export interface TeeProof {
  kind: 1 | 2;
  request_hash: string;
  response_hash: string;
  signer: string;
  signature: string;
}

const INTENT_DOMAIN = new TextEncoder().encode("nearbuddy-intent-v1");
const u64le = (v: string | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
/** borsh Vec<u8>: u32 LE length, then the bytes. */
const vec = (bytes: Uint8Array) => {
  const n = Buffer.alloc(4);
  n.writeUInt32LE(bytes.length);
  return Buffer.concat([n, bytes]);
};

/** INTENT_DOMAIN || borsh(Intent), the bytes an agent signs (arena/src/types.rs field order). */
export function intentMessage(i: Intent): Uint8Array {
  const size = Buffer.alloc(2);
  size.writeUInt16LE(i.size_bps);
  return new Uint8Array(
    Buffer.concat([
      INTENT_DOMAIN,
      vec(b64.dec(i.agent_pk)),
      u64le(i.duel_id),
      Buffer.from([i.side === "Long" ? 0 : 1]),
      size,
      u64le(i.nonce),
      u64le(i.expires_at),
      vec(b64.dec(i.proof_hash)),
    ]),
  );
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
