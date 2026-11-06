// Everything the agent page reads, in one server-side module, so the source can be swapped for a per-agent
// v1 route without touching the page: the agent's record from the arena contract (the same body as
// GET /api/agent, through its handler and cache), its decisions from the published dataset, the leaderboard
// for opponents' model names, and the block time of the decisions on screen (the proof drawer shows it).
import { GET as agentRoute } from "../../api/agent/route";
import { ms, nearOf } from "../../api/arena";
import { type Decision, getDecisions } from "../../api/dataset";
import { ARENA, viewOn } from "../../api/near";

type Side = Decision["side"];
type RawMandate = { allowance: string; spent: string; per_tx_cap: string; expires_at: string; revoked: boolean };
type RawDuel = {
  id: string;
  opponent: string;
  result: "open" | "tie" | "win" | "loss";
  pnl: number | null;
  side: Side | null;
  size_bps: number | null;
  attacks: number;
};
type Raw = {
  scanned: number;
  indexed?: boolean;
  slash_bps: number;
  min_chaos_deposit: string;
  agent: {
    owner: string;
    model_id: string;
    bond: string;
    alpha_bps: number;
    in_duel: string | null;
    tee: boolean;
  } | null;
  followers: [string, RawMandate][];
  duels: RawDuel[];
};

export type Follower = { account: string; cap: number; spent: number; total: number; until: number; revoked: boolean };
export type DuelRow = {
  id: number;
  opponent: string;
  opponentModel: string | null;
  result: RawDuel["result"];
  returnPct: number | null;
  side: Side | null;
  sizePct: number | null;
  attacks: number;
};
/** One agent in human units: NEAR, percent, milliseconds. */
export type AgentData = {
  pk: string;
  model: string;
  owner: string;
  bond: number;
  returnPct: number; // every duel since it joined, the contract's running total
  verified: boolean;
  inDuel: number | null;
  followers: Follower[];
  duels: DuelRow[]; // newest first
  indexed: boolean; // read from the contract's per-agent index, else scanned from the newest duels
  scanned: number;
  slashPct: number;
  attackCost: number;
  prompt: string | null; // the prompt arm of its newest published decision
  prompts: string[]; // every arm it ran, in order of first use
  attacked: Decision[]; // every attacked decision in the dataset, oldest first
  recent: Decision[]; // its newest 10 decisions, newest first
  stamps: Record<string, number>; // decision tx -> block time (ms)
};

const KEY = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, standard base64, as the contract stores agent keys
export const isKey = (pk: string) => KEY.test(pk);

const view = viewOn(ARENA);
let names: { at: number; map: Map<string, string> } | null = null;
/** pk -> model id for every registered agent, re-read at most once a minute; the last list beats none. */
async function modelsByKey() {
  if (names && Date.now() - names.at < 60_000) return names.map;
  try {
    const lb = (await view("leaderboard", {})) as { pk: string; model_id: string }[];
    names = { at: Date.now(), map: new Map(lb.map((a) => [a.pk, a.model_id])) };
  } catch {}
  return names?.map ?? new Map<string, string>();
}

const TX_API = process.env.FASTNEAR_TX_API ?? "https://tx.test.fastnear.com";
const stamped = new Map<string, number>(); // transactions are immutable; FIFO cap below
/** Block time of each tx, from FastNEAR's public transaction API (one call, at most 20 hashes). */
async function stamps(txs: string[]): Promise<Record<string, number>> {
  const missing = txs.filter((t) => !stamped.has(t)).slice(0, 20);
  if (missing.length)
    try {
      const r = await fetch(`${TX_API}/v0/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx_hashes: missing }),
        cache: "no-store",
        signal: AbortSignal.timeout(6_000),
      });
      const j = (await r.json()) as {
        transactions: { transaction: { hash: string }; execution_outcome: { block_timestamp: number } }[];
      };
      for (const t of j.transactions ?? [])
        stamped.set(t.transaction.hash, Math.floor(t.execution_outcome.block_timestamp / 1e6));
      while (stamped.size > 2000) stamped.delete(stamped.keys().next().value as string);
    } catch {} // no time means no drawer for that row; the page links the transaction instead
  return Object.fromEntries(txs.flatMap((t) => (stamped.has(t) ? [[t, stamped.get(t) as number]] : [])));
}

/** The agent page's data; null for a key the contract does not know. Throws when the chain read fails. */
export async function load(pk: string): Promise<AgentData | null> {
  const [res, all, models] = await Promise.all([
    agentRoute(new Request(`http://local/api/agent?pk=${encodeURIComponent(pk)}`)),
    getDecisions(),
    modelsByKey(),
  ]);
  const raw = (await res.json()) as Raw | { error: string };
  if ("error" in raw) throw new Error(raw.error);
  const a = raw.agent;
  if (!a) return null;
  const mine = all.filter((d) => d.agent === pk);
  const attacked = mine.filter((d) => d.attack);
  const recent = mine.slice(-10).reverse();
  const txs = [...new Set([...recent, ...attacked.slice(-3)].flatMap((d) => (d.tx ? [d.tx] : [])))];
  return {
    pk,
    model: a.model_id,
    owner: a.owner,
    bond: nearOf(a.bond),
    returnPct: a.alpha_bps / 100,
    verified: a.tee,
    inDuel: a.in_duel == null ? null : Number(a.in_duel),
    followers: raw.followers.map(([account, m]) => ({
      account,
      cap: nearOf(m.per_tx_cap),
      spent: nearOf(m.spent),
      total: nearOf(m.allowance),
      until: ms(m.expires_at),
      revoked: m.revoked,
    })),
    duels: raw.duels.map((d) => ({
      id: Number(d.id),
      opponent: d.opponent,
      opponentModel: models.get(d.opponent) ?? null,
      result: d.result,
      returnPct: d.pnl == null ? null : d.pnl / 100,
      side: d.side,
      sizePct: d.size_bps == null ? null : d.size_bps / 100,
      attacks: d.attacks,
    })),
    indexed: !!raw.indexed,
    scanned: raw.scanned,
    slashPct: raw.slash_bps / 100,
    attackCost: nearOf(raw.min_chaos_deposit, 2),
    prompt: mine.at(-1)?.arm ?? null,
    prompts: [...new Set(mine.map((d) => d.arm))],
    attacked,
    recent,
    stamps: await stamps(txs),
  };
}
