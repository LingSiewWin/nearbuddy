// Chain events for one duel, read from FastNEAR's tx API (POST /v0/account then /v0/transactions, <= 20
// hashes a call): the tx that opened it and by which method, and its `commit` / `intent` events in chain
// order. One scan of the arena's newest 200 txs (~3 h
// of testnet blocks) is shared by every duel id and kept 20 s; txs already parsed are not fetched again.
// Older duels fall outside the window, which the body says (`oldest_ms`). A stale scan beats a 502.

import type { ChainEvent, Opened } from "../../cells";
import { ARENA, json } from "../near";
import { eventsOf, opensOf, type Tx } from "./chain";

const TX_API = process.env.FASTNEAR_TX_API ?? "https://tx.test.fastnear.com/v0";
const TTL = 20_000;
const ID_RE = /^\d{1,12}$/;

type Parsed = { opens: Opened[]; events: ChainEvent[] };
type Scan = { at: number; oldest_ms: number | null; txs: Map<string, Parsed> };

let last: Scan | null = null;
let inflight: Promise<Scan> | null = null;

async function txApi<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${TX_API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`fastnear ${path} ${r.status}`);
  return (await r.json()) as T;
}

async function scan(): Promise<Scan> {
  const { account_txs } = await txApi<{ account_txs: { transaction_hash: string; tx_block_timestamp: string }[] }>(
    "/account",
    { account_id: ARENA },
  );
  const txs = new Map<string, Parsed>();
  const fresh: string[] = [];
  for (const t of account_txs) {
    const hit = last?.txs.get(t.transaction_hash);
    if (hit) txs.set(t.transaction_hash, hit);
    else fresh.push(t.transaction_hash);
  }
  for (let i = 0; i < fresh.length; i += 20) {
    const { transactions } = await txApi<{ transactions: Tx[] }>("/transactions", {
      tx_hashes: fresh.slice(i, i + 20),
    });
    // not-yet-indexed txs are absent here and fetched on the next scan
    for (const t of transactions) txs.set(t.transaction.hash, { opens: opensOf(t, ARENA), events: eventsOf(t, ARENA) });
  }
  const times = account_txs.map((t) => Math.floor(Number(t.tx_block_timestamp) / 1e6));
  return { at: Date.now(), oldest_ms: times.length ? Math.min(...times) : null, txs };
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("duel");
  if (!id || !ID_RE.test(id)) return json(JSON.stringify({ error: "duel must be a duel number" }), 400);
  let s = last;
  if (!s || Date.now() - s.at >= TTL) {
    inflight ??= scan().finally(() => {
      inflight = null;
    });
    try {
      s = last = await inflight;
    } catch (e) {
      if (!s) return json(JSON.stringify({ error: String(e).slice(0, 200) }), 502);
    }
  }
  const all = [...s.txs.values()];
  const opened = all.flatMap((p) => p.opens).find((o) => o.duel_id === id) ?? null;
  const events = all
    .flatMap((p) => p.events)
    .filter((e) => e.duel_id === id)
    .sort((x, y) => x.at_ms - y.at_ms);
  return json(JSON.stringify({ at: s.at, source: TX_API, window: s.txs.size, oldest_ms: s.oldest_ms, opened, events }));
}
