// The league home's one body, built from the keyless arena's duels: the live match, the last finished one, and the
// model and coach standings (lib/league.ts). Pure: api/league/route.ts does the reading.
import type { Duel, Intent } from "../lib/abi/arena";
import { type AgentInfo, coachRows, modelRows, type Row, type Scored } from "../lib/league";

/** One side of a match. `pnl` is the scored bps once resolved; null while open (the page computes live P&L). */
export type Side = {
  pk: string;
  model: string;
  owner: string;
  side: "Long" | "Short" | null;
  size_bps: number | null;
  pnl: number | null;
};
export type Match = {
  id: string;
  symbol: string;
  open_at: string;
  close_at: string;
  open_price: string | null;
  resolved: boolean;
  a: Side;
  b: Side;
  winner: "A" | "B" | "Tie" | null;
  attacks: number;
};
export type League = {
  at: number;
  network: string;
  contract: string | null;
  live: Match | null;
  last: Match | null;
  models: Row[];
  coaches: Row[];
  /** The live match's next shout price in yoctoNEAR (the contract's chaos_fee); null with no live match. */
  shout_fee: string | null;
};

/** How many of the newest duels the route reads. */
export const SCAN = 200;

const sideOf = (pk: string, it: Intent | null, pnl: number | null, agents: Map<string, AgentInfo>): Side => {
  const a = agents.get(pk);
  return {
    pk,
    model: a ? (a.model_id.split("/").pop() ?? a.model_id) : "?",
    owner: a?.owner ?? "?",
    side: it?.side ?? null,
    size_bps: it?.size_bps ?? null,
    pnl,
  };
};

const matchOf = (d: Duel, agents: Map<string, AgentInfo>): Match => {
  const o = d.resolved ? d.outcome : null;
  return {
    id: d.id,
    symbol: d.symbol,
    open_at: d.open_at,
    close_at: d.close_at,
    open_price: o?.open_price ?? d.open_price,
    resolved: d.resolved,
    a: sideOf(d.a, d.last_intent_a, o ? o.pnl_a : null, agents),
    b: sideOf(d.b, d.last_intent_b, o ? o.pnl_b : null, agents),
    winner: o ? (o.winner === null ? "Tie" : o.winner === d.a ? "A" : "B") : null,
    attacks: o ? o.injections : d.injections.length,
  };
};

const newest = (ds: Duel[]): Duel | null =>
  ds.reduce<Duel | null>((best, d) => (!best || BigInt(d.id) > BigInt(best.id) ? d : best), null);

export function build(
  duels: Duel[],
  agents: Map<string, AgentInfo>,
  nowNs: bigint,
  network: string,
  contract: string,
): League {
  const done = duels.filter((d) => d.resolved && d.outcome);
  // a voided match (no oracle price: open_price 0, both sides scored 0) is a game for nobody
  const played = done.filter((d) => d.outcome?.open_price !== "0");
  const live = newest(duels.filter((d) => !d.resolved && BigInt(d.close_at) > nowNs));
  const last = newest(done);
  const scored: Scored[] = played.map((d) => ({
    duel: d.id,
    a: d.a,
    b: d.b,
    pnl_a: d.outcome?.pnl_a ?? 0,
    pnl_b: d.outcome?.pnl_b ?? 0,
    winner: d.outcome?.winner ?? null,
  }));
  return {
    at: Date.now(),
    network,
    contract,
    live: live ? matchOf(live, agents) : null,
    last: last ? matchOf(last, agents) : null,
    models: modelRows(scored, agents),
    coaches: coachRows(scored, agents),
    shout_fee: null, // the route reads it: it changes with every paid shout
  };
}
