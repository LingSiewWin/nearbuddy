// One planted headline, read back from its transaction for the share card: which duel and side it hit, what it paid,
// whether the arena accepted it, and whether a headline handed in the share link is the one whose sha256 went on
// chain. Pure apart from hashing, so bun test runs it on a real FastNEAR body (app/__tests__/fixtures).
import { createHash } from "node:crypto";

/** The slice of a FastNEAR /v0/transactions entry this file reads. */
export type TxBody = {
  transaction: {
    hash: string;
    signer_id: string;
    receiver_id: string;
    actions: ({ FunctionCall?: { method_name: string; args: string; deposit: string } } | string)[];
  };
  receipts: {
    receipt: { receiver_id: string };
    execution_outcome: { block_timestamp: string | number; outcome: { status: unknown } };
  }[];
};

export type Planted = {
  tx: string;
  signer: string;
  contract: string;
  duel_id: string;
  target: string;
  kind: string;
  payload_hash: string;
  deposit: string;
  /** The arena's own receipt succeeded: the injection is on chain (a refused one still has a tx hash). */
  landed: boolean;
  at_ms: number;
};

/** The first inject_chaos call to `arena` in a tx, or null when the tx holds none. */
export function plantedOf(t: TxBody, arena: string): Planted | null {
  if (t.transaction.receiver_id !== arena) return null;
  for (const a of t.transaction.actions) {
    const f = typeof a === "object" ? a.FunctionCall : undefined;
    if (f?.method_name !== "inject_chaos") continue;
    let args: { duel_id?: unknown; target?: unknown; kind?: unknown; payload_hash?: unknown };
    try {
      args = JSON.parse(Buffer.from(f.args, "base64").toString("utf8"));
    } catch {
      return null;
    }
    const r = t.receipts.find((x) => x.receipt.receiver_id === arena);
    const st = r?.execution_outcome.outcome.status;
    return {
      tx: t.transaction.hash,
      signer: t.transaction.signer_id,
      contract: arena,
      duel_id: String(args.duel_id ?? ""),
      target: String(args.target ?? ""),
      kind: String(args.kind ?? ""),
      payload_hash: String(args.payload_hash ?? ""),
      deposit: String(f.deposit),
      landed: typeof st === "object" && st !== null && ("SuccessValue" in st || "SuccessReceiptId" in st),
      at_ms: r ? Math.floor(Number(r.execution_outcome.block_timestamp) / 1e6) : 0,
    };
  }
  return null;
}

/** The headline a share link carries is the one on chain: its sha256 (base64) equals the injection's payload_hash. */
export const sameText = (text: string | null | undefined, payloadHash: string) =>
  !!text && createHash("sha256").update(text).digest("base64") === payloadHash;

export const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/; // base58 tx hash
