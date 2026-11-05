// NearBuddy protocol: IOU encoding + signing. Must be byte-identical to contract/src/lib.rs.
import { serialize } from "borsh";
import { KeyPair, KeyType, PublicKey, type KeyPairString } from "near-api-js";

export const IOU_DOMAIN = new TextEncoder().encode("nearbuddy-iou-v1");

export interface Iou {
  owner: string;      // vault owner account id
  agent_pk: string;   // base64, 32 bytes
  payee: string;      // resource server account id
  amount: string;     // yoctoNEAR as decimal string
  nonce: string;      // u64 as decimal string
  expires_at: string; // unix ns as decimal string
}

export interface SignedIou {
  iou: Iou;
  signature: string; // base64, 64 bytes
}

// borsh layout of the Rust `Iou` struct: String, Vec<u8>, String, u128, u64, u64
const IOU_SCHEMA = {
  struct: {
    owner: "string",
    agent_pk: { array: { type: "u8" } },
    payee: "string",
    amount: "u128",
    nonce: "u64",
    expires_at: "u64",
  },
} as const;

export const b64 = {
  enc: (b: Uint8Array) => Buffer.from(b).toString("base64"),
  dec: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
};

/** Bytes the agent signs: IOU_DOMAIN || borsh(iou). */
export function iouMessage(iou: Iou): Uint8Array {
  const body = serialize(IOU_SCHEMA, {
    owner: iou.owner,
    agent_pk: b64.dec(iou.agent_pk),
    payee: iou.payee,
    amount: BigInt(iou.amount),
    nonce: BigInt(iou.nonce),
    expires_at: BigInt(iou.expires_at),
  });
  const out = new Uint8Array(IOU_DOMAIN.length + body.length);
  out.set(IOU_DOMAIN);
  out.set(body, IOU_DOMAIN.length);
  return out;
}

/** An agent is just an ed25519 keypair. No NEAR account, no balance. */
export class Agent {
  readonly kp: KeyPair;
  private nonce = BigInt(Date.now()) * 1000n; // unique across restarts; contract only needs uniqueness
  constructor(secret?: KeyPairString) {
    this.kp = secret ? KeyPair.fromString(secret) : KeyPair.fromRandom("ed25519");
  }
  /** 32 raw key bytes, base64 (what the contract stores). */
  get pkB64(): string {
    return b64.enc(this.kp.getPublicKey().data);
  }
  get pkString(): string {
    return this.kp.getPublicKey().toString();
  }
  sign(fields: Omit<Iou, "agent_pk" | "nonce">): SignedIou {
    const iou: Iou = { ...fields, agent_pk: this.pkB64, nonce: (this.nonce++).toString() };
    const { signature } = this.kp.sign(iouMessage(iou));
    return { iou, signature: b64.enc(signature) };
  }
}

export function verifyIou(s: SignedIou): boolean {
  const pk = b64.dec(s.iou.agent_pk);
  if (pk.length !== 32) return false;
  const pub = new PublicKey({ keyType: KeyType.ED25519, data: pk });
  return pub.verify(iouMessage(s.iou), b64.dec(s.signature));
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
