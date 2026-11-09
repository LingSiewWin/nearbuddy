// Arena view answers for the solver tests, typed by the generated ABI types: every field the contract writes is
// present, and a test overrides only the ones it reads.
import type { AgentView, Config, Duel } from "../../protocol/src/abi/arena.ts";
import type { ArenaConfigAnyDeploy } from "../../protocol/src/chain.ts";

/** `get_config` of a current arena (deploy 17). */
export const config = (over: Partial<Config> = {}): Config => ({
  chaos: { base: "0", cap: "0", fee_bps: 0, r_bps: 10_000, share_bps: 0 },
  commit_reveal: false,
  fee_bps: 0,
  intent_lock_s: 300,
  intents_account: "intents-stub.testnet",
  max_vault_per_account: "0",
  max_vault_total: "0",
  migrating: false,
  min_chaos_deposit: "0",
  min_duel_s: 310,
  next_duel: "0",
  no_reveal_bps: 0,
  open_duels: 0,
  oracle_account: "oracle.testnet",
  oracle_deposit: "0",
  owner: "owner.testnet",
  owner_fees: "0",
  paused: false,
  require_consent: false,
  slash_bps: 0,
  vault_total: "0",
  withdraw_delay_s: 900,
  ...over,
});

/** `get_config` of deploy 14, which has no `intents_account`. */
export const configV14 = (over: Partial<Config> = {}): ArenaConfigAnyDeploy => {
  const { intents_account: _, ...v14 } = config(over);
  return v14;
};

export const agent = (pk: string, over: Partial<AgentView> = {}): AgentView => ({
  alpha_bps: 0,
  bond: "100",
  in_duel: null,
  model_id: "m",
  owner: "owner.testnet",
  pk,
  shield: 0,
  tee: true,
  ...over,
});

export const duel = (over: Partial<Duel> = {}): Duel => ({
  a: "A",
  b: "B",
  close_at: "0",
  id: "0",
  injections: [],
  last_intent_a: null,
  last_intent_b: null,
  open_at: "0",
  open_price: null,
  outcome: null,
  pool: "0",
  resolved: false,
  symbol: "wrap.near",
  ...over,
});
