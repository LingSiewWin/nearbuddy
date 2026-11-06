// One duel read from the arena contract on the public RPC: the duel record plus both agents' views, the
// config (commit-reveal fields when the contract has them) and get_no_reveal (null before commit-reveal).
// Cached 20 s per id; pollers share one in-flight read, and a stale record beats an error while the RPC
// is throttled. `duelSummary()` is the v1 shape: human units, both sides, the attacks, the decisions with
// reasoning from the published dataset, and the duel's events when they are still on the live tape.
import { proven } from "../cells";
import { NET } from "../network";
import { type Agent, type Duel, type Intent, ms, nearOf, snapshot, symbolOf, usd, ZERO } from "./arena";
import { attackText, getDecisions } from "./dataset";
import { ARENA, RPC, viewOn } from "./near";
import { tape } from "./tape";

const ORACLE = process.env.ORACLE_ACCOUNT ?? NET.oracle;
const TTL = 20_000;
const view = viewOn(ARENA);
export const ID_RE = /^\d{1,12}$/;

export type DuelRecord = {
  at: number;
  rpc: string;
  contract: string;
  oracle: string;
  config: unknown;
  no_reveal: unknown;
  duel: Duel | null;
  a: Agent | null;
  b: Agent | null;
};

const cache = new Map<string, { at: number; rec: DuelRecord }>();
const inflight = new Map<string, Promise<DuelRecord>>();

async function build(id: string): Promise<DuelRecord> {
  const [duel, config, no_reveal] = await Promise.all([
    view("get_duel", { duel_id: id }) as Promise<Duel | null>,
    view("get_config", {}),
    view("get_no_reveal", { duel_id: id }).catch(() => null), // view missing before commit-reveal
  ]);
  const [a, b] = duel
    ? ((await Promise.all([view("get_agent", { agent_pk: duel.a }), view("get_agent", { agent_pk: duel.b })])) as [
        Agent | null,
        Agent | null,
      ])
    : [null, null];
  return { at: Date.now(), rpc: RPC, contract: ARENA, oracle: ORACLE, config, no_reveal, duel, a, b };
}

/** The raw record (contract units) for an id already checked against ID_RE. */
export async function duelRecord(id: string): Promise<DuelRecord> {
  const hit = cache.get(id);
  // a resolved duel never changes; an open one is re-read every TTL
  if (hit && (hit.rec.duel?.resolved || Date.now() - hit.at < TTL)) return hit.rec;
  // ids at or past next_duel do not exist yet: answer without touching the RPC
  if (!hit && BigInt(id) >= BigInt((await snapshot()).config.next_duel))
    return {
      at: Date.now(),
      rpc: RPC,
      contract: ARENA,
      oracle: ORACLE,
      config: null,
      no_reveal: null,
      duel: null,
      a: null,
      b: null,
    };
  let p = inflight.get(id);
  if (!p) {
    p = build(id)
      .then((rec) => {
        cache.set(id, { at: rec.at, rec });
        if (cache.size > 200) cache.delete(cache.keys().next().value as string);
        return rec;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  if (hit) {
    p.catch(() => {});
    return hit.rec;
  }
  return p;
}

// ---------- v1: human units ----------
const side = (pk: string, i: Intent | null, a: Agent | null, pnl: number | null) => ({
  agent: pk,
  model: a?.model_id ?? "unregistered",
  side: i?.side ?? null,
  size_pct: i ? i.size_bps / 100 : null,
  verified: proven(i, ZERO),
  return_pct: pnl == null ? null : pnl / 100,
});

export async function duelSummary(id: string, now = Date.now()) {
  const r = await duelRecord(id);
  const d = r.duel;
  if (!d) return null;
  const n = Number(id);
  const [rows, events] = await Promise.all([
    getDecisions(),
    tape()
      .then((t) => t.events.filter((e) => "duel" in e && e.duel === n))
      .catch(() => []), // the tape only holds the newest transactions; older duels have none
  ]);
  const o = d.outcome ?? null;
  // the contract drops the injection list on resolve and keeps only a count; the tape may still hold them
  const attacks = d.resolved
    ? events.flatMap((e) =>
        e.kind === "attack" && e.ok ? [{ target: e.target, kind: e.attack, text: e.text, payload_sha256: e.hash }] : [],
      )
    : await Promise.all(
        d.injections.map(async (j) => ({
          target: j.target,
          kind: j.kind,
          text: await attackText(j.payload_hash),
          payload_sha256: j.payload_hash,
        })),
      );
  return {
    at: r.at,
    network: "testnet",
    contract: r.contract,
    oracle: r.oracle,
    duel: n,
    market: symbolOf(d.symbol),
    opened_at: ms(d.open_at),
    closes_at: ms(d.close_at),
    seconds_left: d.resolved ? null : Math.max(0, Math.round((ms(d.close_at) - now) / 1000)),
    resolved: d.resolved,
    open_price_usd: usd(o?.open_price ?? d.open_price),
    close_price_usd: usd(o?.close_price),
    pot_near: nearOf(d.pool),
    a: side(d.a, d.last_intent_a, r.a, o?.pnl_a ?? null),
    b: side(d.b, d.last_intent_b, r.b, o?.pnl_b ?? null),
    winner: o?.winner ?? null,
    slashed_near: nearOf(o?.slashed),
    attack_count: d.resolved ? (o?.injections ?? 0) : d.injections.length,
    attacks,
    decisions: rows.filter((x) => x.duel === String(n)).reverse(),
    events,
  };
}
export type DuelSummary = NonNullable<Awaited<ReturnType<typeof duelSummary>>>;
