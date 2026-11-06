// Chain events for one duel, read from FastNEAR's tx API (POST /v0/account then /v0/transactions, <= 20
// hashes a call): the tx that opened it and by which method, and its `commit` / `intent` events in chain
// order. One scan of the arena's newest 200 txs (~3 h of testnet blocks) is shared by every duel id and
// kept 20 s. Parsed txs outlive scans, so a scan only fetches hashes it has not parsed yet. A batch that
// fails (FastNEAR 429s a cold burst) ends the scan early: what was parsed is served with `partial: true`
// and the rest is fetched on the next scan. Any failure backs the next scan off to TTL/2, so an outage
// costs one attempt per 10 s, not one per poll. Older duels fall outside the window (`oldest_ms`).
import type { ChainEvent, Opened } from "../../cells";
import { ARENA, json } from "../near";
import { eventsOf, fastnearTxApi, opensOf, type Tx } from "./chain";

const TX_API = process.env.FASTNEAR_TX_API ?? fastnearTxApi(process.env.NEAR_NETWORK);
const TTL = 20_000;
const BACKOFF = TTL / 2;
const ID_RE = /^\d{1,12}$/;

type Parsed = { opens: Opened[]; events: ChainEvent[] };
type Scan = { at: number; next: number; oldest_ms: number | null; txs: Parsed[]; window: number; partial: boolean };

const parsed = new Map<string, Parsed>(); // by tx hash, pruned to the latest window each scan
let last: Scan | null = null;
let failed: { at: number; error: string } | null = null; // a failed scan with nothing to serve yet
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
  const hashes = account_txs.map((t) => t.transaction_hash);
  const keep = new Set(hashes);
  for (const h of parsed.keys()) if (!keep.has(h)) parsed.delete(h);
  const fresh = hashes.filter((h) => !parsed.has(h));
  let partial = false;
  for (let i = 0; i < fresh.length; i += 20) {
    let transactions: Tx[];
    try {
      ({ transactions } = await txApi<{ transactions: Tx[] }>("/transactions", { tx_hashes: fresh.slice(i, i + 20) }));
    } catch {
      partial = true; // the unfetched hashes stay fresh and are fetched on the next scan
      break;
    }
    // not-yet-indexed txs are absent here and fetched on the next scan
    for (const t of transactions)
      parsed.set(t.transaction.hash, { opens: opensOf(t, ARENA), events: eventsOf(t, ARENA) });
  }
  const times = account_txs.map((t) => Math.floor(Number(t.tx_block_timestamp) / 1e6));
  const txs = hashes.flatMap((h) => parsed.get(h) ?? []);
  return {
    at: Date.now(),
    next: Date.now() + (partial ? BACKOFF : TTL),
    oldest_ms: times.length ? Math.min(...times) : null,
    txs,
    window: txs.length,
    partial,
  };
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("duel");
  if (!id || !ID_RE.test(id)) return json(JSON.stringify({ error: "duel must be a duel number" }), 400);
  let s = last;
  const backingOff = !s && failed && Date.now() - failed.at < BACKOFF;
  if (backingOff) return json(JSON.stringify({ error: failed?.error }), 502);
  if (!s || Date.now() >= s.next) {
    inflight ??= scan().finally(() => {
      inflight = null;
    });
    try {
      s = last = await inflight;
      failed = null;
    } catch (e) {
      const error = String(e).slice(0, 200);
      if (!s) {
        failed = { at: Date.now(), error };
        return json(JSON.stringify({ error }), 502);
      }
      s = last = { ...s, next: Date.now() + BACKOFF }; // serve the stale scan, retry in TTL/2
    }
  }
  const opened = s.txs.flatMap((p) => p.opens).find((o) => o.duel_id === id) ?? null;
  const events = s.txs
    .flatMap((p) => p.events)
    .filter((e) => e.duel_id === id)
    .sort((x, y) => x.at_ms - y.at_ms);
  const { at, oldest_ms, window, partial } = s;
  return json(JSON.stringify({ at, source: TX_API, window, oldest_ms, partial, opened, events }));
}
