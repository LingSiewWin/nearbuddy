// One planted headline, read back from its transaction for the share card: which duel and side it hit, what it paid,
// whether the arena accepted it, and whether a headline handed in the share link is the one whose sha256 went on
// chain (deploy 16). On deploy 17 the call carries the headline itself and returns the record's index in get_chaos.
// Pure apart from hashing, so bun test runs it on a real FastNEAR body (app/__tests__/fixtures).
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
  /** Deploy 17: the headline the call carried (on chain once landed), else null. */
  headline: string | null;
  /** Deploy 17: the call's return value, the injection's index in `get_chaos(duel_id)`; null before it lands. */
  index: number | null;
};

const sha256b64 = (s: string) => createHash("sha256").update(s).digest("base64");

/** The first inject_chaos call to `arena` in a tx, or null when the tx holds none. */
export function plantedOf(t: TxBody, arena: string): Planted | null {
  if (t.transaction.receiver_id !== arena) return null;
  for (const a of t.transaction.actions) {
    const f = typeof a === "object" ? a.FunctionCall : undefined;
    if (f?.method_name !== "inject_chaos") continue;
    let args: { duel_id?: unknown; target?: unknown; kind?: unknown; payload_hash?: unknown; headline?: unknown };
    try {
      args = JSON.parse(Buffer.from(f.args, "base64").toString("utf8"));
    } catch {
      return null;
    }
    const r = t.receipts.find((x) => x.receipt.receiver_id === arena);
    const st = r?.execution_outcome.outcome.status;
    const ok = typeof st === "object" && st !== null && ("SuccessValue" in st || "SuccessReceiptId" in st);
    const headline = typeof args.headline === "string" ? args.headline : null;
    // deploy 17 returns the index as JSON; deploy 16 returns nothing ("")
    const ret = ok ? (st as { SuccessValue?: string }).SuccessValue : undefined;
    const index = ret ? Number(Buffer.from(ret, "base64").toString("utf8")) : Number.NaN;
    return {
      tx: t.transaction.hash,
      signer: t.transaction.signer_id,
      contract: arena,
      duel_id: String(args.duel_id ?? ""),
      target: String(args.target ?? ""),
      kind: String(args.kind ?? ""),
      // deploy 17 hashes the headline on chain: the same sha256 Duel.injections lists
      payload_hash: headline !== null ? sha256b64(headline) : String(args.payload_hash ?? ""),
      deposit: String(f.deposit),
      landed: ok,
      at_ms: r ? Math.floor(Number(r.execution_outcome.block_timestamp) / 1e6) : 0,
      headline,
      index: Number.isInteger(index) && index >= 0 ? index : null,
    };
  }
  return null;
}

/** The headline a share link carries is the one on chain: its sha256 (base64) equals the injection's payload_hash. */
export const sameText = (text: string | null | undefined, payloadHash: string) =>
  !!text && sha256b64(text) === payloadHash;

/** The only headline a card may print, so nobody can put text on this domain with a failing tx that costs only gas:
 *  never one from a refused call. Deploy 17: the chain's own record (get_chaos) of this landed call. Deploy 16: the
 *  link's text when the call landed and its sha256 is the one the call put on chain. */
export const shownText = (p: Planted, linkText: string | null, record: { headline: string } | null): string | null =>
  !p.landed
    ? null
    : p.headline !== null
      ? (record?.headline ?? null)
      : sameText(linkText, p.payload_hash)
        ? linkText
        : null;

export const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/; // base58 tx hash
