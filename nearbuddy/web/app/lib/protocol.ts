// The slice of packages/protocol the duel verifier needs (Vercel builds web/ alone, so web cannot import it):
// intent bytes, the enclave's signed text, proof_hash and ed25519 verify. Same outputs as
// packages/protocol/src/intent.ts and index.ts; web/app/__tests__/verify.test.ts checks them against it on real
// intents. Server only (node:crypto, Buffer). The intent body is borsh written by hand: borsh is not a web dependency.
import { createHash } from "node:crypto";
import { KeyType, PublicKey } from "near-api-js";

export const b64 = {
  enc: (b: Uint8Array) => Buffer.from(b).toString("base64"),
  dec: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
  /** near-sdk `Base64VecU8`: standard alphabet, padded, canonical; anything that does not re-encode to itself throws. */
  strict: (s: unknown): Uint8Array => {
    const b = typeof s === "string" ? Buffer.from(s, "base64") : null;
    if (!b || b.toString("base64") !== s) throw new RangeError(`bad base64: ${JSON.stringify(s)}`);
    return new Uint8Array(b);
  },
};

/** A contract `EVENT_JSON:` log with u64 numbers of 16+ digits kept as decimal strings (JSON.parse rounds past 2^53). */
export function parseEventJson(log: string): unknown {
  const body = log.startsWith("EVENT_JSON:") ? log.slice("EVENT_JSON:".length) : log;
  // strings match first and stay as they are, so digits inside a memo or label are never touched
  return JSON.parse(
    body.replace(/"(?:[^"\\]|\\.)*"|([:,[]\s*)(\d{16,})(?=\s*[,}\]])/g, (m, p, d) => (d ? `${p}"${d}"` : m)),
  );
}
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
// Same input rules as the contract's JSON ingress (fixtures/wire-vectors.json "edges"), as packages/protocol.
const U64_MAX = (1n << 64n) - 1n;
const u64le = (v: unknown) => {
  const n = typeof v === "string" && /^\+?[0-9]+$/.test(v) ? BigInt(v.replace(/^\+/, "")) : -1n;
  if (n < 0n || n > U64_MAX) throw new RangeError(`bad u64: ${JSON.stringify(v)}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
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
  const s: unknown = i.size_bps;
  if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > 0xffff) throw new RangeError(`bad u16: ${s}`);
  if (i.side !== "Long" && i.side !== "Short") throw new RangeError(`bad side: ${JSON.stringify(i.side)}`);
  const size = Buffer.alloc(2);
  size.writeUInt16LE(s);
  return new Uint8Array(
    Buffer.concat([
      INTENT_DOMAIN,
      vec(b64.strict(i.agent_pk)),
      u64le(i.duel_id),
      Buffer.from([i.side === "Long" ? 0 : 1]),
      size,
      u64le(i.nonce),
      u64le(i.expires_at),
      vec(b64.strict(i.proof_hash)),
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
  try {
    const pk = b64.strict(pkB64);
    if (pk.length !== 32) return false;
    return new PublicKey({ keyType: KeyType.ED25519, data: pk }).verify(msg, b64.strict(sigB64));
  } catch {
    return false;
  }
}
