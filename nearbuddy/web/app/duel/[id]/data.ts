"use server";
// One duel for the duel page, in human units (NEAR, USD, percent, ms): the contract's record and both agents,
// every arena transaction of that duel, and each model's own reasoning from the published dataset. While the
// duel is recent its transactions come from the live tape; older ones from FastNEAR's account history around
// the duel's window. Dataset calls the scan missed are looked up by their own hash, so a call never gets a
// made-up time. The page renders the first frame with this on the server and polls it while the duel is open.
// Kept in one module so it can move onto GET /api/v1/duels/<id> once that route exists.
import type { Agent, Config, Duel } from "../../api/arena";
import { ms, nearOf, usd, ZERO } from "../../api/arena";
import { attackText, type Decision, getDecisions } from "../../api/dataset";
import { ARENA, viewOn } from "../../api/near";
import { type ArenaEvent, decode } from "../../api/tape";
import { tape } from "../../api/tape";
import type { Focus } from "../../arena/model";

export type DuelSide = Focus["a"] & { score: number | null };
export type DuelData = Focus & {
  a: DuelSide;
  b: DuelSide;
  attacks: number | null; // the contract's own count; attack payloads leave its storage at resolve
  events: ArenaEvent[]; // this duel's transactions, oldest first
  decisions: Decision[]; // dataset rows for this duel, with each model's reasoning
  source: "tape" | "history" | "dataset";
  at: number;
};

const TX_API = process.env.FASTNEAR_TX_API ?? "https://tx.test.fastnear.com";
const BLOCK_MS = 610; // testnet block time, only to aim the first history page; each page re-aims from its own blocks
const ID = /^\d{1,12}$/;
const view = viewOn(ARENA);

type Meta = { transaction_hash: string; tx_block_height: number; tx_block_timestamp: string; is_success: boolean };
type Tx = {
  transaction: Parameters<typeof decode>[1]["transaction"];
  execution_outcome: { block_height: number; block_timestamp: number };
  receipts: {
    receipt: { receiver_id: string };
    execution_outcome: { outcome: { logs: string[]; status: Record<string, unknown> } };
  }[];
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

/** Decoded arena events for these transactions, 20 hashes per request (the endpoint's cap). */
async function byHash(hashes: string[]): Promise<ArenaEvent[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < hashes.length; i += 20) chunks.push(hashes.slice(i, i + 20));
  const lists = await Promise.all(
    chunks.map(async (c) => {
      const { transactions } = await post<{ transactions: Tx[] }>("/v0/transactions", { tx_hashes: c });
      return Promise.all(
        (transactions ?? []).map(async (t) => {
          const e = decode(
            {
              transaction_hash: t.transaction.hash,
              tx_block_height: t.execution_outcome.block_height,
              tx_block_timestamp: String(t.execution_outcome.block_timestamp),
              is_success: !t.receipts.some(
                (r) => r.receipt.receiver_id === ARENA && "Failure" in r.execution_outcome.outcome.status,
              ),
            },
            t,
          );
          if (e.kind === "attack") e.text = await attackText(e.hash);
          return e;
        }),
      );
    }),
  );
  return lists.flat();
}

/** Arena transactions around a duel that has scrolled off the tape. FastNEAR pages an account's history
 *  newest first, 200 per page, from a resume token; the token is (block height << 32 | tx index), so the
 *  first page is aimed at an estimated height and re-aimed from the blocks it returns. */
// ponytail: the token layout is read off FastNEAR's responses, not documented; if it changes this returns
// nothing and the dataset lookup below still dates every published call
async function history(opened: number, closes: number, anchor: { block: number; at: number } | null) {
  const ts = (m: Meta) => Number(m.tx_block_timestamp) / 1e6;
  const want = closes + 15 * 60_000; // past the bell, so a late resolve_duel is on the page too
  const aim = (block: number, at: number) =>
    String(BigInt(Math.max(0, Math.round(block + (want - at) / BLOCK_MS))) << 32n);
  let token = anchor ? aim(anchor.block, anchor.at) : undefined; // no anchor: read the newest page, aim from it
  const got: Meta[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await post<{ account_txs?: Meta[]; resume_token?: string }>("/v0/account", {
      account_id: ARENA,
      max_tx_count: 200,
      ...(token ? { resume_token: token } : {}),
    });
    const page = r.account_txs ?? [];
    const hi = page[0];
    const lo = page.at(-1);
    if (!hi || !lo) break;
    if (!got.length && (ts(hi) < closes || ts(lo) > want)) {
      const end = ts(hi) < closes ? hi : lo; // the page missed the duel: re-aim from its nearer end
      token = aim(end.tx_block_height, ts(end));
      continue;
    }
    got.push(...page);
    if (ts(lo) <= opened - 90_000 || !r.resume_token) break;
    token = r.resume_token;
  }
  const win = got.filter((m) => ts(m) >= opened - 90_000 && ts(m) <= closes);
  const after = got.filter((m) => ts(m) > closes).slice(-20); // newest first: the 20 right after the bell
  return [...after, ...win].map((m) => m.transaction_hash);
}

const belongs = (id: number, d: Duel, closes: number) => (e: ArenaEvent) =>
  e.kind === "open"
    ? e.duel === id || (e.duel == null && e.a === d.a && e.b === d.b && Math.abs(e.closeAt - closes) < 5_000)
    : "duel" in e && e.duel === id;

async function eventsOf(id: number, d: Duel, opened: number, closes: number, decisions: Decision[]) {
  const mine = belongs(id, d, closes);
  const live = (await tape().catch(() => null))?.events ?? [];
  const oldest = live.at(-1);
  const covered = !!oldest && (oldest.at <= opened - 60_000 || live.some((e) => e.kind === "open" && mine(e)));
  let source: DuelData["source"] = "tape";
  let events = covered ? live.filter(mine) : [];
  if (!covered) {
    const top = live[0];
    events = await history(opened, closes, top ? { block: top.block, at: top.at } : null)
      .then(byHash)
      .then((l) => l.filter(mine))
      .catch(() => []);
    source = events.length ? "history" : "dataset";
  }
  const have = new Set(events.map((e) => e.tx));
  const missing = decisions.flatMap((r) => (r.tx && !have.has(r.tx) ? [r.tx] : []));
  if (missing.length) events.push(...(await byHash(missing).catch(() => [])).filter(mine));
  return { events: events.sort((x, y) => x.at - y.at || x.block - y.block), source };
}

let config: { at: number; c: Config } | null = null;
const getConfig = async () => {
  if (!config || Date.now() - config.at > 300_000) config = { at: Date.now(), c: (await view("get_config", {})) as Config };
  return config.c;
};

// resolved duels never change: kept 10 min (the dataset tail may still add reasoning); open ones 5 s
const cache = new Map<string, DuelData>();

/** The duel page's data; null when the id is not a duel on this contract. */
export async function loadDuel(id: string): Promise<DuelData | null> {
  if (!ID.test(id)) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < (hit.live ? 5_000 : 600_000)) return hit;
  const d = (await view("get_duel", { duel_id: id })) as Duel | null;
  if (!d) return null;
  const [a, b, c, all] = await Promise.all([
    view("get_agent", { agent_pk: d.a }) as Promise<Agent | null>,
    view("get_agent", { agent_pk: d.b }) as Promise<Agent | null>,
    getConfig(),
    getDecisions(),
  ]);
  const n = Number(id);
  const opened = ms(d.open_at);
  const closes = ms(d.close_at);
  const decisions = all.filter((r) => r.duel === id);
  const { events, source } = await eventsOf(n, d, opened, closes, decisions);
  const o = d.outcome ?? null;
  const side = (pk: string, ag: Agent | null, i: Duel["last_intent_a"], pnl: number | undefined): DuelSide => ({
    agent: pk,
    model: ag?.model_id ?? "unknown",
    side: i?.side ?? null,
    size_pct: i ? i.size_bps / 100 : null,
    verified: !!i && i.proof_hash !== ZERO,
    bond: ag ? nearOf(ag.bond) : null,
    score: pnl == null ? null : pnl / 100,
  });
  const out: DuelData = {
    duel: n,
    live: !d.resolved,
    opened,
    closes,
    open: usd(o?.open_price ?? d.open_price),
    close: usd(o?.close_price),
    pot: nearOf(d.pool),
    a: side(d.a, a, d.last_intent_a, o?.pnl_a),
    b: side(d.b, b, d.last_intent_b, o?.pnl_b),
    winner: o?.winner ?? null,
    slashed: nearOf(o?.slashed, 4),
    lockS: c.intent_lock_s,
    slashPct: c.slash_bps / 100,
    attacks: o ? (o.injections ?? null) : d.injections.length,
    events,
    decisions,
    source,
    at: Date.now(),
  };
  cache.set(id, out);
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return out;
}
