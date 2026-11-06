// Read-only arena snapshot from the public RPC: config, leaderboard and the last SCAN duels (followers are
// read per agent by the agent routes).
// The solver's GET /arena is optional enrichment (intent txs, injection payloads, quotes, fills); everything
// renders without it. Built at most once per TTL however many tabs poll; a stale body beats a 500 while the
// RPC is throttled. Resolved duels never change, so they are kept in memory and not re-read.
// `summary()` turns the raw snapshot into the v1 shape: human units (NEAR, USD, %, ms) and per-agent
// records, with each agent's prompt and attack verdicts joined from the published dataset.
import { proven } from "../cells";
import { calls } from "../lib/rows";
import { tally } from "../lib/verdict";
import { NETWORK_ID } from "../network";
import { attackText, type Decision, getDecisions } from "./dataset";
import { ARENA, RPC, SOLVER_URL, viewOn } from "./near";

const SCAN = Number(process.env.ARENA_SCAN ?? 40);
const TTL = 20_000;
const view = viewOn(ARENA);
export const ZERO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export type Side = "Long" | "Short";
export type Intent = {
  agent_pk: string;
  duel_id: string;
  side: Side;
  size_bps: number;
  nonce: string;
  expires_at: string;
  proof_hash?: string; // absent while a commit-reveal call is sealed
};
export type Agent = {
  owner: string;
  pk: string;
  model_id: string;
  bond: string;
  alpha_bps: number;
  shield: number;
  in_duel: string | null;
  tee: boolean;
};
export type Injection = { kind: string; payload_hash: string; target: string; block: string };
export type Outcome = {
  open_price: string;
  close_price: string;
  pnl_a: number;
  pnl_b: number;
  winner: string | null;
  slashed: string;
  injections?: number;
};
export type Duel = {
  id: string;
  a: string;
  b: string;
  symbol: string;
  open_at: string;
  close_at: string;
  pool: string;
  injections: Injection[];
  resolved: boolean;
  last_intent_a: Intent | null;
  last_intent_b: Intent | null;
  outcome?: Outcome | null;
  open_price?: string | null;
};
export type Mandate = {
  allowance: string;
  spent: string;
  per_tx_cap: string;
  allowed_tokens: string[];
  expires_at: string;
  revoked: boolean;
};
export type Config = {
  next_duel: string;
  slash_bps: number;
  min_chaos_deposit: string;
  min_duel_s: number;
  intent_lock_s: number;
  open_duels: number;
  // deploy 14 (absent before): sealed calls, the forfeit for not revealing, and consent to be paired
  commit_reveal?: boolean;
  no_reveal_bps?: number;
  require_consent?: boolean;
};
export type Snap = {
  at: number;
  rpc: string;
  contract: string;
  config: Config;
  leaderboard: Agent[];
  duels: Duel[];
  solver: unknown;
};

let cache: { at: number; snap: Snap } | null = null;
let inflight: Promise<Snap> | null = null;
const resolved = new Map<string, Duel>();

async function duel(id: string): Promise<Duel | null> {
  const hit = resolved.get(id);
  if (hit) return hit;
  const d = (await view("get_duel", { duel_id: id })) as Duel | null;
  if (d?.resolved) {
    resolved.set(id, d);
    if (resolved.size > 500) resolved.delete(resolved.keys().next().value as string);
  }
  return d;
}

/** `leaderboard` args: deploy 15 pages the board ({from, limit} required, limit <= 100); deploy 14 ignores them.
 *  ponytail: one page (11 agents today); page through when the arena passes 100 agents. */
export const BOARD = { from: 0, limit: 100 };

async function build(): Promise<Snap> {
  const config = (await view("get_config", {})) as Config;
  const n = Number(config.next_duel);
  const ids = Array.from({ length: Math.min(SCAN, n) }, (_, i) => String(n - 1 - i));
  const [leaderboard, solver] = await Promise.all([
    view("leaderboard", BOARD) as Promise<Agent[]>,
    fetch(`${SOLVER_URL}/arena`, { cache: "no-store", signal: AbortSignal.timeout(2_000) })
      .then((r) => r.json())
      .catch(() => null),
  ]);
  const scanned: (Duel | null)[] = [];
  for (let i = 0; i < ids.length; i += 8) scanned.push(...(await Promise.all(ids.slice(i, i + 8).map(duel)))); // trickle, not a burst
  return {
    at: Date.now(),
    rpc: RPC,
    contract: ARENA,
    config,
    leaderboard,
    duels: scanned.filter((d): d is Duel => !!d),
    solver,
  };
}

/** The newest snapshot. A stale one is returned at once while a refresh runs in the background, so a slow
 *  or throttled RPC never holds a page; only the very first call waits for the chain. */
export async function snapshot(): Promise<Snap> {
  if (cache && Date.now() - cache.at < TTL) return cache.snap;
  if (!inflight)
    inflight = build()
      .then((snap) => {
        cache = { at: snap.at, snap };
        return snap;
      })
      .finally(() => {
        inflight = null;
      });
  if (cache) {
    inflight.catch(() => {}); // the stale copy stands; the next call retries
    return cache.snap;
  }
  return inflight;
}

// ---------- v1 summary: human units ----------
const YOCTO = 10n ** 24n;
export const nearOf = (y: string | null | undefined, d = 3) => {
  if (!y) return 0;
  const v = BigInt(y);
  const scaled = (v * 10n ** BigInt(d)) / YOCTO; // integer in units of 10^-d NEAR, so no float sum drifts
  return Number(scaled) / 10 ** d;
};
export const usd = (p: string | number | null | undefined) => (p == null ? null : Number(p) / 1e8);
export const ms = (ns: string | number) => Math.floor(Number(BigInt(ns) / 1_000_000n));
export const symbolOf = (s: string) => (s === "wrap.near" ? "NEAR/USD" : s);
export const shortModel = (m: string) =>
  m
    .split("/")
    .pop()
    ?.replace(/-\d{4}$/, "") ?? m;

/** Per agent from the published dataset: the prompt it ran most recently, how it met attacks, and how often
 * its call matched the next price move (a coin flip is 50%). */
function attackRecord(decisions: Decision[]) {
  const by = new Map<string, { prompt: string; rows: Decision[] }>();
  for (const r of decisions) {
    const e = by.get(r.agent) ?? { prompt: r.arm, rows: [] };
    e.prompt = r.arm;
    e.rows.push(r);
    by.set(r.agent, e);
  }
  return new Map(
    [...by].map(([k, e]) => [
      k,
      {
        prompt: e.prompt,
        prompts: [...new Set(e.rows.map((r) => r.arm))],
        attacks: tally(e.rows),
        calls: calls(e.rows),
      },
    ]),
  );
}

export type Side1 = { agent: string; model: string; side: Side | null; size_pct: number | null; verified: boolean };
const sideOf = (pk: string, i: Intent | null, lb: Agent[]): Side1 => ({
  agent: pk,
  model: lb.find((a) => a.pk === pk)?.model_id ?? "unregistered",
  side: i?.side ?? null,
  size_pct: i ? i.size_bps / 100 : null,
  verified: proven(i, ZERO),
});

export async function summary(s: Snap, now = Date.now()) {
  const ATTACKS = attackRecord(await getDecisions());
  const lb = s.leaderboard;
  const done = s.duels.filter((d) => d.resolved && d.outcome);
  const open = s.duels.filter((d) => !d.resolved);
  const trusted = (pk: string) => {
    const a = lb.find((x) => x.pk === pk);
    return !!a?.tee && !a.model_id.startsWith("stub/");
  };
  // the hero is the newest open duel between enclave-verified models; red-team or test duels never take it
  const live = open.find((d) => trusted(d.a) && trusted(d.b)) ?? open[0]; // live_duels lists every open one
  const liveAttacks = await Promise.all(
    (live?.injections ?? []).map(async (j) => ({
      target: j.target,
      kind: j.kind,
      text: await attackText(j.payload_hash),
      payload_sha256: j.payload_hash,
    })),
  );
  const record = (pk: string) => {
    const mine = done.filter((d) => d.a === pk || d.b === pk);
    const won = mine.filter((d) => d.outcome?.winner === pk).length;
    const tied = mine.filter((d) => !d.outcome?.winner).length;
    const bps = mine.reduce((s, d) => s + ((d.a === pk ? d.outcome?.pnl_a : d.outcome?.pnl_b) ?? 0), 0);
    return { won, lost: mine.length - won - tied, tied, window: mine.length, return_pct: bps / 100 };
  };
  const standings = lb
    .filter((a) => a.tee && !a.model_id.startsWith("stub/")) // the rest stay on /terminal
    .map((a) => {
      const atk = ATTACKS.get(a.pk);
      return {
        agent: a.pk,
        model: a.model_id,
        owner: a.owner,
        prompt: atk?.prompt ?? null,
        prompts: atk?.prompts ?? [],
        verified: a.tee,
        return_pct: a.alpha_bps / 100,
        record: record(a.pk),
        attacks: atk?.attacks ?? tally([]),
        calls: atk?.calls ?? { scored: 0, right: 0 },
        bond_near: nearOf(a.bond),
        in_duel: a.in_duel == null ? null : Number(a.in_duel),
      };
    });
  return {
    at: s.at,
    network: NETWORK_ID,
    contract: s.contract,
    duels_total: Number(s.config.next_duel),
    live_duels: open.map((d) => Number(d.id)),
    rules: {
      duel_seconds_min: s.config.min_duel_s,
      decisions_locked_last_seconds: s.config.intent_lock_s,
      loser_slashed_pct: s.config.slash_bps / 100,
      attack_cost_near: nearOf(s.config.min_chaos_deposit, 2),
      sealed_calls: !!s.config.commit_reveal,
      no_reveal_forfeit_pct: (s.config.no_reveal_bps ?? 0) / 100,
      pairing_needs_consent: !!s.config.require_consent,
    },
    live: live
      ? {
          duel: Number(live.id),
          market: symbolOf(live.symbol),
          opened_at: ms(live.open_at),
          closes_at: ms(live.close_at),
          seconds_left: Math.max(0, Math.round((ms(live.close_at) - now) / 1000)),
          pot_near: nearOf(live.pool),
          open_price_usd: usd(live.open_price),
          a: sideOf(live.a, live.last_intent_a, lb),
          b: sideOf(live.b, live.last_intent_b, lb),
          attacks: liveAttacks,
        }
      : null,
    standings,
    recent: done.slice(0, 10).map((d) => ({
      duel: Number(d.id),
      opened_at: ms(d.open_at),
      closed_at: ms(d.close_at),
      market: symbolOf(d.symbol),
      open_price_usd: usd(d.outcome?.open_price),
      close_price_usd: usd(d.outcome?.close_price),
      a: { ...sideOf(d.a, d.last_intent_a, lb), return_pct: (d.outcome?.pnl_a ?? 0) / 100 },
      b: { ...sideOf(d.b, d.last_intent_b, lb), return_pct: (d.outcome?.pnl_b ?? 0) / 100 },
      winner: d.outcome?.winner ?? null,
      slashed_near: nearOf(d.outcome?.slashed),
      attacks: d.outcome?.injections ?? 0,
    })),
  };
}
export type Summary = Awaited<ReturnType<typeof summary>>;
