// Hand-built arena snapshots in the shape app/api/arena.ts reads from the contract views (get_config,
// leaderboard, get_duel), so summary() and the pages' derivations can be checked offline. Agent keys are
// made up on purpose: they never match a row of the published dataset, whether or not app/data exists.
import type { Agent, Config, Duel, Intent, Outcome, Snap } from "../../api/arena";

export const YOCTO = "000000000000000000000000"; // append to a whole number of NEAR
export const ZERO_PROOF = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
export const NOW = 1_793_978_400_000;
export const ns = (msAt: number) => `${msAt}000000`;

export const config = (o: Partial<Config> = {}): Config => ({
  next_duel: "12",
  slash_bps: 1000,
  min_chaos_deposit: "100000000000000000000000", // 0.1 NEAR
  min_duel_s: 300,
  intent_lock_s: 30,
  open_duels: 1,
  ...o,
});

export const agent = (pk: string, model_id: string, o: Partial<Agent> = {}): Agent => ({
  owner: "nearbuddy-solver.testnet",
  pk,
  model_id,
  bond: `5${YOCTO}`,
  alpha_bps: 0,
  shield: 0,
  in_duel: null,
  tee: true,
  ...o,
});

export const intent = (agent_pk: string, duel_id: string, side: Intent["side"], o: Partial<Intent> = {}): Intent => ({
  agent_pk,
  duel_id,
  side,
  size_bps: 5000,
  nonce: "1",
  expires_at: ns(NOW + 60_000),
  proof_hash: "q83vEjRWeJA=",
  ...o,
});

export const outcome = (o: Partial<Outcome> = {}): Outcome => ({
  open_price: "377386666",
  close_price: "378033333",
  pnl_a: 0,
  pnl_b: 0,
  winner: null,
  slashed: "0",
  ...o,
});

export const duel = (id: string, a: string, b: string, o: Partial<Duel> = {}): Duel => ({
  id,
  a,
  b,
  symbol: "wrap.near",
  open_at: ns(NOW - 300_000),
  close_at: ns(NOW),
  pool: "0",
  injections: [],
  resolved: true,
  last_intent_a: null,
  last_intent_b: null,
  outcome: outcome(),
  ...o,
});

export const snap = (o: Partial<Snap> = {}): Snap => ({
  at: NOW,
  rpc: "offline",
  contract: "arena.nearbuddy-solver.testnet",
  config: config(),
  leaderboard: [],
  duels: [],
  solver: null,
  ...o,
});
