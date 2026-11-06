// Live event tape for the arena contract, read from FastNEAR's public transaction API (no key): the newest
// transactions to the contract, each decoded into one event from its method args and the contract's
// EVENT_JSON logs (intent, open_price, resolve live in the same receipt tree). Attack payloads are only a
// sha256 on chain; known texts (from the published dataset) are joined back by hash.
// The account list is re-read at most every TTL ms (one fetch at a time, however many clients poll);
// transactions are immutable, so their decoded events are kept by hash.
import { attackText } from "./dataset";
import { ARENA } from "./near";

const TX_API = process.env.FASTNEAR_TX_API ?? "https://tx.test.fastnear.com";
const TTL = 3_000;
const LIST = 60; // newest transactions per read
const BATCH = 20; // the transactions endpoint takes at most 20 hashes

import type { Side } from "../lib/verdict";

type Base = { tx: string; at: number; block: number; ok: boolean; signer: string };
export type ArenaEvent = Base &
  (
    | { kind: "intent"; duel: number; agent: string; side: Side; size: number; nonce: string; tee: number }
    | {
        kind: "attack";
        duel: number;
        target: string;
        attack: string;
        hash: string;
        text: string | null;
        paid: string;
      }
    | { kind: "open"; duel: number | null; a: string; b: string; closeAt: number; price: number | null }
    | {
        kind: "resolve";
        duel: number;
        pnlA: number | null;
        pnlB: number | null;
        open: number | null;
        close: number | null;
      }
    | { kind: "register"; agent: string; model: string; tee: boolean }
    | { kind: "other"; method: string }
  );

type AccountTx = { transaction_hash: string; tx_block_height: number; tx_block_timestamp: string; is_success: boolean };
type FcAction = { FunctionCall?: { method_name: string; args: string; deposit: string } };
type TxDetail = {
  transaction: { hash: string; signer_id: string; actions: (FcAction | string)[] };
  receipts: { receipt: { receiver_id: string }; execution_outcome: { outcome: { logs: string[] } } }[];
};

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const r = await fetch(`${TX_API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`fastnear ${path} ${r.status}`);
  return (await r.json()) as T;
};

/** The contract's NEP-297 events in a transaction's receipt tree. */
const events = (t: TxDetail) =>
  t.receipts
    .filter((r) => r.receipt.receiver_id === ARENA)
    .flatMap((r) => r.execution_outcome.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(11)) as { standard: string; event: string; data: Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .filter((e) => e?.standard === "nearbuddy-arena") as { event: string; data: Record<string, unknown> }[];

const num = (v: unknown) => (v == null ? null : Number(v));

export function decode(meta: AccountTx, t: TxDetail): ArenaEvent {
  const base: Base = {
    tx: meta.transaction_hash,
    at: Math.floor(Number(meta.tx_block_timestamp) / 1e6),
    block: meta.tx_block_height,
    ok: meta.is_success,
    signer: t.transaction.signer_id,
  };
  const fc = t.transaction.actions.map((a) => (typeof a === "string" ? undefined : a.FunctionCall)).find(Boolean);
  if (!fc) return { ...base, kind: "other", method: "deploy" };
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(Buffer.from(fc.args, "base64").toString("utf8"));
  } catch {}
  const ev = events(t);
  const find = (name: string) => ev.find((e) => e.event === name)?.data;
  switch (fc.method_name) {
    case "post_intent": {
      const i = (args.signed as { intent?: Record<string, unknown> } | undefined)?.intent ?? {};
      const tee = (args.tee as { kind?: number } | undefined)?.kind ?? 0;
      return {
        ...base,
        kind: "intent",
        duel: Number(i.duel_id),
        agent: String(i.agent_pk),
        side: i.side as Side,
        size: Number(i.size_bps),
        nonce: String(i.nonce),
        tee: base.ok ? tee : 0,
      };
    }
    case "inject_chaos": {
      const hash = String(args.payload_hash);
      return {
        ...base,
        kind: "attack",
        duel: Number(args.duel_id),
        target: String(args.target),
        attack: String(args.kind),
        hash,
        text: null, // joined by hash in build()
        paid: fc.deposit,
      };
    }
    case "open_duel": {
      const o = find("open_price");
      return {
        ...base,
        kind: "open",
        duel: num(o?.duel_id),
        a: String(args.a),
        b: String(args.b),
        closeAt: Math.floor(Number(args.close_at) / 1e6),
        price: num(o?.price),
      };
    }
    case "resolve_duel": {
      const r = find("resolve");
      return {
        ...base,
        kind: "resolve",
        duel: Number(args.duel_id),
        pnlA: num(r?.pnl_a),
        pnlB: num(r?.pnl_b),
        open: num(r?.open),
        close: num(r?.close),
      };
    }
    case "register_agent":
      return {
        ...base,
        kind: "register",
        agent: String(args.agent_pk),
        model: String(args.model_id),
        tee: Boolean(args.tee),
      };
    default:
      return { ...base, kind: "other", method: fc.method_name };
  }
}

const seen = new Map<string, ArenaEvent>(); // ponytail: FIFO cap 2000, plenty for a 60-tx window
let cache: { at: number; list: ArenaEvent[] } | null = null;
let inflight: Promise<ArenaEvent[]> | null = null;

async function build(): Promise<ArenaEvent[]> {
  const { account_txs } = await post<{ account_txs: AccountTx[] }>("/v0/account", {
    account_id: ARENA,
    max_tx_count: LIST,
  });
  const missing = account_txs.filter((m) => !seen.has(m.transaction_hash));
  const chunks: AccountTx[][] = [];
  for (let i = 0; i < missing.length; i += BATCH) chunks.push(missing.slice(i, i + BATCH));
  await Promise.all(
    chunks.map(async (c) => {
      const { transactions } = await post<{ transactions: TxDetail[] }>("/v0/transactions", {
        tx_hashes: c.map((m) => m.transaction_hash),
      });
      const byHash = new Map(transactions.map((t) => [t.transaction.hash, t]));
      for (const m of c) {
        const t = byHash.get(m.transaction_hash);
        if (!t) continue;
        const e = decode(m, t);
        if (e.kind === "attack") e.text = await attackText(e.hash);
        seen.set(m.transaction_hash, e);
      }
    }),
  );
  while (seen.size > 2000) seen.delete(seen.keys().next().value as string);
  return account_txs
    .map((m) => seen.get(m.transaction_hash))
    .filter((e): e is ArenaEvent => !!e)
    .sort((a, b) => b.block - a.block || b.at - a.at);
}

/** Newest-first arena events; a stale list beats an error while the indexer hiccups. */
export async function tape(): Promise<{ at: number; events: ArenaEvent[] }> {
  if (cache && Date.now() - cache.at < TTL) return { at: cache.at, events: cache.list };
  if (!inflight)
    inflight = build()
      .then((list) => {
        cache = { at: Date.now(), list };
        return list;
      })
      .finally(() => {
        inflight = null;
      });
  try {
    const list = await inflight;
    return { at: cache?.at ?? Date.now(), events: list };
  } catch (e) {
    if (cache) return { at: cache.at, events: cache.list };
    throw e;
  }
}
