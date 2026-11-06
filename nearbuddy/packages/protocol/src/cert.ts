// Guarantee certificate: what the solver signs when a card is swiped. Byte-identical to
// `GuaranteeCert` in contract/src/lib.rs (borsh, prefixed by CERT_DOMAIN).
import { serialize } from "borsh";
import { type KeyPair, KeyType, PublicKey } from "near-api-js";
import { b64 } from "./index.ts";

export const CERT_DOMAIN = new TextEncoder().encode("nearbuddy-cert-v1");

export interface GuaranteeCert {
  solver: string;
  issuer: string;
  chain_id: number; // u64 (fits in number for EIP-155 ids)
  wallet: string; // 0x-hex payer wallet on the target chain
  token: string; // 0x-hex token contract
  amount: string; // token units as decimal string (USDC 6 dp)
  payout: string; // yoctoNEAR paid to the issuer if the pull fails
  nonce: string; // u64 decimal string
  expires_at: string; // unix ns decimal string
}

export interface SignedCert {
  cert: GuaranteeCert;
  signature: string;
}
export type PullOutcome = { Pulled: { tx_hash: string } } | { Failed: { reason: string } };
export interface PullSettlement {
  signed: SignedCert;
  outcome: PullOutcome;
}

const CERT_SCHEMA = {
  struct: {
    solver: "string",
    issuer: "string",
    chain_id: "u64",
    wallet: "string",
    token: "string",
    amount: "u128",
    payout: "u128",
    nonce: "u64",
    expires_at: "u64",
  },
} as const;

export function certMessage(c: GuaranteeCert): Uint8Array {
  const body = serialize(CERT_SCHEMA, {
    ...c,
    chain_id: BigInt(c.chain_id),
    amount: BigInt(c.amount),
    payout: BigInt(c.payout),
    nonce: BigInt(c.nonce),
    expires_at: BigInt(c.expires_at),
  });
  const out = new Uint8Array(CERT_DOMAIN.length + body.length);
  out.set(CERT_DOMAIN);
  out.set(body, CERT_DOMAIN.length);
  return out;
}

export function signCert(kp: KeyPair, cert: GuaranteeCert): SignedCert {
  return { cert, signature: b64.enc(kp.sign(certMessage(cert)).signature) };
}

export function verifyCert(s: SignedCert, solverPkB64: string): boolean {
  const pk = b64.dec(solverPkB64);
  if (pk.length !== 32) return false;
  return new PublicKey({ keyType: KeyType.ED25519, data: pk }).verify(certMessage(s.cert), b64.dec(s.signature));
}
