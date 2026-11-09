// Generated from abi/arena.json by packages/protocol/src/abi/gen.ts (bun run gen:types). Do not edit.

/** `Agent` plus whether every intent must carry a verified TEE proof. */
export interface AgentView {
  alpha_bps: number;
  bond: string;
  in_duel: string | null;
  model_id: string;
  /**
   * NEAR Account Identifier.
   *
   * This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
   *
   * [See the crate-level docs for information about validation.](index.html#account-id-rules)
   *
   * Also see [Error kind precedence](AccountId#error-kind-precedence).
   *
   * ## Examples
   *
   * ``` use near_account_id::AccountId;
   *
   * let alice: AccountId = "alice.near".parse().unwrap();
   *
   * assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
   */
  owner: string;
  pk: Base64VecU8;
  shield: number;
  tee: boolean;
}

/** How the runner must deliver the headline: `Cue` as written, `Clean` after the cue guard strips its credibility cues, `Placebo` as written (a placebo carries no cues). The contract draws `Cue` or `Clean` from the block's random seed; the injector does not choose. */
export type Arm = "Cue" | "Clean" | "Placebo";

export interface AssetOptionalPrice {
  asset_id: string;
  price: OraclePrice | null;
}

/** Base64 string on the wire (near-sdk's ABI reports Vec<u8>). */
export type Base64VecU8 = string;

/**
 * One planted headline (deploy 17). `Duel.injections[i]` and `get_chaos(duel)[i]` are the same injection.
 *
 * `prev` is the side of the target's last decision made at or before `at` (a decision's time is its commit time when revealed, else its accept time), updated while the injection is pending. The first decision made after `at` that is revealed from a commitment and carries a verified provider-TEE proof (kind 2) decides the outcome, once; direct posts never decide, since their side is readable before they land.
 */
export interface Chaos {
  arm: Arm;
  /** Block time of the injection (ns). */
  at: string;
  claimed: boolean;
  /** Nonce of the revealed intent that decided the outcome. */
  decided_by: string | null;
  /** UTF-8, 1..=280 bytes, no control or invisible format characters. */
  headline: string;
  /**
   * NEAR Account Identifier.
   *
   * This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
   *
   * [See the crate-level docs for information about validation.](index.html#account-id-rules)
   *
   * Also see [Error kind precedence](AccountId#error-kind-precedence).
   *
   * ## Examples
   *
   * ``` use near_account_id::AccountId;
   *
   * let alice: AccountId = "alice.near".parse().unwrap();
   *
   * assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
   */
  injector: string;
  kind: ChaosKind;
  next: Side | null;
  outcome: ChaosOutcome;
  /** Owed to `injector` once the duel finished: the stake back (no trial, expired, or flipped less the fee) plus, for a flip at the duel's loser, a share of its slash. */
  payout: string;
  prev: Side | null;
  /** Escrowed in the duel pool until it finishes. 0 when the contract owner (placebo) or the owner of either agent paid: that deposit went to `owner_fees` at injection. */
  stake: string;
  target: Base64VecU8;
}

/** Price and payout terms of `inject_chaos` (deploy 17). The `n`-th paid injection of a duel (placebos not counted) needs a deposit of at least `min(cap, max(min_chaos_deposit, base * (r_bps / 10_000)^n))`, rounded down at each step. At finish `fee_bps` of a decided stake (flipped or held) goes to `owner_fees`, and `share_bps` of the loser's slash is split pro rata by stake among the injections that flipped it. */
export interface ChaosConfig {
  base: string;
  cap: string;
  fee_bps: number;
  r_bps: number;
  share_bps: number;
}

/** The side a planted headline's lie pushes the target toward, or `Placebo`: a neutral headline, injected only by the contract owner as the control arm. */
export type ChaosKind = "Long" | "Short" | "Placebo";

/** What the target's first counting decision after the injection showed (see `Chaos`). */
export type ChaosOutcome = "Pending" | "Flipped" | "Held" | "NoTrial" | "Expired";

export interface Config {
  /** `inject_chaos` price and payout terms (deploy 17). */
  chaos: ChaosConfig;
  /** `post_intent` refused; intents go through `commit_intent` / `reveal_intent`. */
  commit_reveal: boolean;
  fee_bps: number;
  /** No intent lands in the last `intent_lock_s` of a duel (see `set_oracle`). */
  intent_lock_s: number;
  /** Where fill outputs land and `settle_follow` reads balances (`intents.near` on mainnet). */
  intents_account: string;
  /** `deposit` refused once the caller's own vault would pass this (deploy 16). */
  max_vault_per_account: string;
  /** `deposit` refused once `vault_total` would pass this. */
  max_vault_total: string;
  /** `follows` is being re-keyed by `migrate_follows`; follow and settle are refused meanwhile. */
  migrating: boolean;
  min_chaos_deposit: string;
  /** Floor on `close_at - now`; 310 on testnet (the oracle serves a cached price for 300 s). */
  min_duel_s: number;
  next_duel: string;
  /** Bond share an unrevealed commitment pays the opponent at scoring, on top of forfeiting. */
  no_reveal_bps: number;
  /** Duels opened and not yet finished or voided (counted from deploy 12 on); while non-zero, `set_oracle` may not lower the lock or move the oracle. */
  open_duels: number;
  /** Outlayer price oracle (`price-oracle.testnet` / `price-oracle.near`). */
  oracle_account: string;
  /** Attached to every `oracle_call`; the oracle refunds what the TEE fetch did not cost. */
  oracle_deposit: string;
  /**
   * NEAR Account Identifier.
   *
   * This is a unique, syntactically valid, human-readable account identifier on the NEAR network.
   *
   * [See the crate-level docs for information about validation.](index.html#account-id-rules)
   *
   * Also see [Error kind precedence](AccountId#error-kind-precedence).
   *
   * ## Examples
   *
   * ``` use near_account_id::AccountId;
   *
   * let alice: AccountId = "alice.near".parse().unwrap();
   *
   * assert!("ƒelicia.near".parse::<AccountId>().is_err()); // (ƒ is not f) ```
   */
  owner: string;
  owner_fees: string;
  /** New activity refused; every exit path stays open (see `set_paused`). */
  paused: boolean;
  /** `open_duel` refused; pairing only through `open_duel_consented`. */
  require_consent: boolean;
  slash_bps: number;
  /** Sum of all vaults (exact for accounting from deploy 16 on; see `reconcile_vault_total`). */
  vault_total: string;
  /** `withdraw` pays a `request_withdraw` only this long after it. */
  withdraw_delay_s: number;
}

export interface Duel {
  a: Base64VecU8;
  b: Base64VecU8;
  close_at: string;
  id: string;
  /** Cleared when the duel finishes; the count survives in `Outcome.injections`. */
  injections: Injection[];
  last_intent_a: Intent | null;
  last_intent_b: Intent | null;
  open_at: string;
  /** Oracle price (u64, 8 dp) snapshotted by the oracle callback right after `open_duel`. */
  open_price: string | null;
  /** Filled by the oracle callback: scored pnl per side and the slashed amount, so a page can show the outcome without parsing logs. */
  outcome: Outcome | null;
  /** Chaos stakes, escrowed until the duel finishes and then settled per injection (see `Chaos`), plus the loser's slashed bond, paid to the winner less the flipped injections' share. */
  pool: string;
  resolved: boolean;
  /** Oracle asset id, e.g. `wrap.near` (NEAR/USD). */
  symbol: string;
}

/** One swap the solver fronted for a follower. The output must already sit in the arena's own `intents.near` balance: `settle_follow` credits it only against that balance. */
export interface Fill {
  /** Amount debited from the follower's vault (mandate units, yoctoNEAR here), before the fee. */
  amount_in: string;
  /** Output credited to the follower's holding; must be covered by unaccounted balance. */
  amount_out: string;
  intent_nonce: string;
  /** Audit string only (tx hash). Empty, over 128 bytes, or `dry-quote:*` is refused. */
  swap_tx: string;
  /** The `intents.near` token id the output landed in, e.g. `nep141:usdc.near`. */
  token: string;
}

/** One injection as `Duel.injections` lists it. From deploy 17 `kind` is the `ChaosKind` name and `payload_hash` is `sha256(headline)`, computed on chain; the full record is in `get_chaos`. */
export interface Injection {
  block: string;
  kind: string;
  payload_hash: Base64VecU8;
  target: Base64VecU8;
}

/** What an agent signs: one directional call inside one duel. */
export interface Intent {
  /** 32-byte ed25519 public key of the agent. */
  agent_pk: Base64VecU8;
  duel_id: string;
  /** Unix ns. Only intents with `expires_at >= duel.close_at` are scored. */
  expires_at: string;
  nonce: string;
  /** `sha256(request_hash || response_hash)` of the NEAR AI Cloud completion that produced this decision (see `TeeProof`). 32 zero bytes when the agent is not TEE-backed. */
  proof_hash: Base64VecU8;
  side: Side;
  /** Position size in basis points of the agent's notional, 1..=10_000. */
  size_bps: number;
}

/** A follower's bound on what the solver may settle against their vault for one agent. `per_tx_cap` and `allowance` bound the whole debit of a fill, fee included. */
export interface Mandate {
  allowance: string;
  /** Empty = any token. */
  allowed_tokens: string[];
  expires_at: string;
  /** Price floor: a fill needs `amount_out * 10^24 >= amount_in * min_out_per_near`, i.e. at least this many output units per NEAR in. `follow` refuses 0; mandates migrated from deploy 14 carry 0 (no floor) until the follower follows again. */
  min_out_per_near?: string;
  per_tx_cap: string;
  revoked: boolean;
  /** When `unfollow` revoked the mandate (unix ns), 0 while active. Fills the solver fronted before the revocation stay settleable for `withdraw_delay_s` after it. Set by the contract; ignored on input. */
  revoked_at?: string;
  spent: string;
}

/** USD = multiplier / 10^decimals. */
export interface OraclePrice {
  decimals: number;
  multiplier: string;
}

export interface Outcome {
  close_price: string;
  /** Injections the duel carried (pruned from `Duel.injections` to free storage). */
  injections: number;
  open_price: string;
  pnl_a: number;
  pnl_b: number;
  slashed: string;
  /** `Some(a)` / `Some(b)` pk of the winner, `None` on a tie. */
  winner: Base64VecU8 | null;
}

/** The terms in force before the last tightening update. They bind fills for intents accepted before `updated_at` at most until `binds_until` (`updated_at + withdraw_delay_s` as set at the update), then those fills are refused. `binds_until` caps the old terms only: the follow windows (`covers`, `refollowed`) still use the live withdraw delay, like the revoke and expiry graces, so a later `set_withdraw_delay` can close a window, or let a re-follow drop `prev`, before `binds_until`. */
export interface PrevTerms {
  binds_until: string;
  /** `spent` here is the snapshot at the update and is never read: the pair's one ledger is the current mandate's `spent`. */
  terms: Mandate;
  updated_at: string;
}

/** `oracle_on_call` payload from `price-oracle.*` (https://price-oracle.outlayer.ai/docs/). */
export interface PriceData {
  prices: AssetOptionalPrice[];
  recency_duration_sec: number;
  /** Unix ns. */
  timestamp: string;
}

export type PromiseOrValueBoolean = boolean;

export interface SettleReport {
  debited: string;
  rejected: [number, string][];
  settled: number;
}

export type Side = "Long" | "Short";

export interface SignedIntent {
  intent: Intent;
  signature: Base64VecU8;
}

/** The NEAR AI Cloud signature record for one completion, as returned by `GET /v1/signature/{chat_id}?signing_algo=ed25519`. The TEE signs the raw text `"{model_id}:{request_hash_hex}:{response_hash_hex}"` (kind 2, `provider_tee`, the model's own enclave) or `"{request_hash_hex}:{response_hash_hex}"` (kind 1, `gateway`, the cloud-api enclave). The contract rebuilds that text from the agent's `model_id` and the two hashes and verifies the ed25519 signature against a signer the owner registered from an attestation report. */
export interface TeeProof {
  /** 1 = gateway TEE, 2 = provider (model) TEE. */
  kind: number;
  /** sha256 of the exact request body bytes. */
  request_hash: Base64VecU8;
  /** sha256 of the exact response body bytes. */
  response_hash: Base64VecU8;
  /** 64-byte ed25519 signature over the text. */
  signature: Base64VecU8;
  /** 32-byte ed25519 `signing_address` of the TEE. */
  signer: Base64VecU8;
}

export interface ArenaViews {
  /**
   * Duel ids an agent took part in, newest first, `limit` entries from offset `from`. Only duels
   *  opened from deploy 10 on are indexed; unknown agents return an empty list.
   *  View: anyone, no deposit, no panics.
   */
  agent_duels: { args: { agent_pk: Base64VecU8; from: number; limit: number }; result: string[] };
  /**
   * The deposit the next paid `inject_chaos` in this duel needs (the price before storage).
   *  View: anyone, no deposit, no panics.
   */
  chaos_fee: { args: { duel_id: string }; result: string };
  /**
   * The exact bytes an agent key signs for `commit_intent(duel_id, _, commitment, sig)`.
   *  View: anyone, no deposit, no panics.
   */
  commit_message: { args: { duel_id: string; commitment: Base64VecU8 }; result: Base64VecU8 };
  /**
   * The exact bytes each agent key signs for `open_duel_consented(a, b, symbol, close_at, ..)`.
   *  View: anyone, no deposit, no panics.
   */
  consent_message: { args: { a: Base64VecU8; b: Base64VecU8; symbol: string; close_at: string }; result: Base64VecU8 };
  contract_source_metadata: { args: Record<string, never>; result: unknown };
  /**
   * The intent lock duel `duel_id` runs (or ran) under, in nanoseconds: no intent lands in its
   *  last `duel_lock` before `close_at`. From deploy 15 this is the value stored when the duel
   *  opened, kept after it finishes; for a duel opened earlier it is today's global lock, since
   *  those duels read the global value. `None` for an unknown duel.
   *  View: anyone, no deposit, no panics.
   */
  duel_lock: { args: { duel_id: string }; result: string | null };
  /**
   * This contract's `intents_account` balance of `token_id` already credited to holdings.
   *  View: anyone, no deposit, no panics.
   */
  get_accounted: { args: { token_id: string }; result: string };
  /**
   * Agent record plus whether it is TEE-bound; `None` for an unknown key. View: anyone, no
   *  deposit, no panics.
   */
  get_agent: { args: { agent_pk: Base64VecU8 }; result: AgentView | null };
  /**
   * Every headline planted in a duel, in `Duel.injections` order, with its arm, outcome and
   *  payout; empty for an unknown duel or one with none. View: anyone, no deposit, no panics.
   */
  get_chaos: { args: { duel_id: string }; result: Chaos[] };
  /** Owner, oracle and fee settings plus the next duel id. View: anyone, no deposit, no panics. */
  get_config: { args: Record<string, never>; result: Config };
  /** Full duel record; `None` for an unknown id. View: anyone, no deposit, no panics. */
  get_duel: { args: { duel_id: string }; result: Duel | null };
  /**
   * The follower's mandate for an agent, if any. Followers per agent are not enumerable on
   *  chain: index the `follow` / `unfollow` events.
   *  View: anyone, no deposit. Panics: "migrating".
   */
  get_follow: { args: { agent_pk: Base64VecU8; follower: string }; result: Mandate | null };
  /**
   * The terms before the follower's last tightening update for `agent_pk`: `{terms, updated_at,
   *  binds_until}` (unix ns); `None` if no update tightened a term since the follow (or since a
   *  re-follow that opened a fresh window). Fills for intents accepted before `updated_at` are
   *  judged by `terms` until `binds_until`, then refused ("mandate updated"); later intents by
   *  `get_follow`. The view keeps returning them after `binds_until`. `terms.spent` is the
   *  snapshot at the update and is not used: the ledger is `get_follow`'s `spent`.
   *  View: anyone, no deposit. Panics: "migrating".
   */
  get_follow_prev: { args: { agent_pk: Base64VecU8; follower: string }; result: PrevTerms | null };
  /**
   * Start of `follower`'s current follow window for `agent_pk` (unix ns): fills for intents
   *  accepted from then on pass the follow-time rule. `None` with no mandate or one stored before
   *  deploy 16 (no follow time). A re-follow inside a closed window's grace also keeps that
   *  window's intents settleable until the grace ends (see `VersionedMandate::refollowed`).
   *  View: anyone, no deposit, no panics.
   */
  get_follow_time: { args: { agent_pk: Base64VecU8; follower: string }; result: string | null };
  /**
   * Fill output credited to `follower` in `token_id` and not yet withdrawn.
   *  View: anyone, no deposit, no panics.
   */
  get_holding: { args: { follower: string; token_id: string }; result: string };
  /**
   * Whether side a / side b of a scored duel left a commitment unrevealed and was slashed
   *  `no_reveal_bps`. `(false, false)` for unknown, open or clean duels.
   *  View: anyone, no deposit, no panics.
   */
  get_no_reveal: { args: { duel_id: string }; result: [boolean, boolean] };
  /**
   * `(amount, ready_at_ns)` of the account's queued vault withdrawal, if any.
   *  View: anyone, no deposit, no panics.
   */
  get_pending_withdraw: { args: { account: string }; result: [string, string] | null };
  /** Vault balance in yoctoNEAR, 0 for an unknown account. View: anyone, no deposit, no panics. */
  get_vault: { args: { account: string }; result: string };
  /**
   * When the agent's intent `nonce` was accepted (unix ns); 0 for one accepted before deploy 16
   *  (time not recorded); `None` if it never was. `settle_follow` compares it with the mandate's
   *  follow time, revoke and expiry. View: anyone, no deposit, no panics.
   */
  intent_accepted_at: { args: { agent_pk: Base64VecU8; nonce: string }; result: string | null };
  /**
   * Hex of the exact bytes an agent signs for `intent`, for off-chain parity checks. View:
   *  anyone, no deposit, no panics.
   */
  intent_message_hex: { args: { intent: Intent }; result: string };
  /**
   * Whether an enclave key is accepted as `TeeProof.signer`. View: anyone, no deposit, no
   *  panics.
   */
  is_tee_signer: { args: { signer: Base64VecU8 }; result: boolean };
  /**
   * Agents sorted by alpha, then shield, descending; `limit` (at most 100) from rank `from`.
   *  ponytail: sorts every agent per call; a sorted index once agents number in the thousands.
   *  View: anyone, no deposit, no panics.
   */
  leaderboard: { args: { from: number; limit: number }; result: AgentView[] };
  /**
   * The exact bytes an agent key signs to be registered by `owner` on this contract.
   *  View: anyone, no deposit, no panics.
   */
  register_message: { args: { owner: string }; result: Base64VecU8 };
  /**
   * The exact text a TEE signs for an agent's completion, for off-chain parity checks.
   *  View: anyone, no deposit, no panics.
   */
  tee_text_utf8: {
    args: { kind: number; model_id: string; request_hash: Base64VecU8; response_hash: Base64VecU8 };
    result: string;
  };
}

export interface ArenaCalls {
  /**
   * Allow `account_id` to call `settle_follow`. Caller: owner. Deposit: 1 yoctoNEAR. Panics:
   *  "not owner".
   * modifiers: payable
   */
  add_solver: { args: { account_id: string }; result: undefined };
  /**
   * Accept intents signed by this NEAR AI Cloud enclave key. The owner takes it from
   *  `GET /v1/attestation/report` after verifying the Intel and NVIDIA quotes off chain; the
   *  report bytes are published in the dataset so anyone can redo that check.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "signer length", "label too long".
   * modifiers: payable
   */
  add_tee_signer: { args: { signer: Base64VecU8; label: string }; result: undefined };
  /**
   * Start a paged reconcile of `vault_total` for more holders than one call can read: then
   *  `reconcile_page` (any number of times) and `finish_reconcile`. Restarts one in progress.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
   * modifiers: payable
   */
  begin_reconcile: { args: Record<string, never>; result: undefined };
  /**
   * Pay the caller everything its injections in a finished duel are owed (`Chaos.payout`), once.
   *  Caller: the injector. Deposit: 1 yoctoNEAR. Panics: "duel missing", "duel open",
   *  "nothing to claim".
   * modifiers: payable
   */
  claim_chaos: { args: { duel_id: string }; result: unknown };
  /**
   * Hide the next decision: store `commitment = sha256(intent_message(intent) || salt)` for
   *  this agent in this duel, replacing an earlier unrevealed one. `sig` is the agent key's
   *  signature over `commit_message(duel_id, commitment)`. Only before the intent lock. The salt
   *  should be 32 random bytes: the intent space is small enough to brute-force without it.
   *  While a headline planted at this agent after its held commitment is pending, that
   *  commitment must be revealed before it is replaced.
   *  Caller: anyone (relayer). Deposit: none; storage is taken from the agent's bond. Panics:
   *  "paused", "agent_pk length", "commitment length", "bad commit signature", "duel missing",
   *  "duel closed", "intent lock", "bad target", "commitment used", "reveal first",
   *  "agent missing", "bond exhausted".
   */
  commit_intent: {
    args: { duel_id: string; agent_pk: Base64VecU8; commitment: Base64VecU8; sig: Base64VecU8 };
    result: undefined;
  };
  /**
   * Follower locks NEAR here. Solvers are repaid from it only inside a mandate. A first deposit
   *  also pays for the vault record.
   *  Caller: anyone (follower). Deposit: the amount to lock, above a first vault record's
   *  storage. Panics: "paused", "deposit required", "vault cap", "account cap" (the caller's vault
   *  would pass `max_vault_per_account`).
   * modifiers: payable
   */
  deposit: { args: Record<string, never>; result: string };
  /**
   * Set `vault_total` to the pending sum and end the reconcile. Returns the new total.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "no reconcile".
   * modifiers: payable
   */
  finish_reconcile: { args: Record<string, never>; result: string };
  /**
   * Attach (or replace) the caller's mandate for an agent. Only enclave-verified agents (TEE
   *  proof on every intent) can be followed. Storage is paid from the vault.
   *  Caller: a follower with a funded vault. Deposit: none; storage is debited from the
   *  vault. `min_out_per_near` must be set (clients derive it from the oracle mid less slippage), so
   *  a solver can never settle a fill for a token amount of output. `revoked_at` is reset to 0 and
   *  `spent` is ignored: the stored one is kept (0 for a new mandate). `revoked: true` is exactly
   *  `unfollow` (stamped now, grace applies; no other term changes, open while paused).
   *  Panics: "paused", "migrating", "agent missing", "agent unverified", "empty mandate",
   *  "price floor required", "refollow too soon", "update too soon", "insufficient". The record
   *  keeps when the follower followed: an update while the mandate is live keeps the window
   *  (fronted fills stay settleable); a re-follow after an unfollow or the expiry refuses only
   *  intents of the gap. New terms bind intents accepted from now on: a tighter term keeps the
   *  old terms for earlier intents for `withdraw_delay_s`, and a second tightening inside that
   *  time is "update too soon" (see `VersionedMandate::refollowed`).
   */
  follow: { args: { agent_pk: Base64VecU8; mandate: Mandate }; result: undefined };
  /**
   * `owner` runs duels (the solver account in the hackathon deploy). `oracle_account` is the
   *  Outlayer price oracle; `oracle_deposit` is attached to each price request. `slash_bps` of the
   *  loser's bond moves to the pool. `fee_bps` is charged on every settled fill, inside the
   *  follower's caps, and accrues to the owner. `intents_account` is where fill outputs land
   *  (`intents.near`, or the stub on testnet). `max_vault_total` caps all vault deposits, and is
   *  also the starting per-account cap (`set_vault_account_cap` lowers it). The
   *  intent lock starts at 0 and the duel floor at 0, so `lock <= floor / 2` holds until
   *  `set_oracle` sets both.
   *  Caller: deployer, once. Deposit: none. Panics: "bps out of range".
   * modifiers: init
   */
  init: {
    args: {
      owner: string;
      oracle_account: string;
      oracle_deposit: string;
      slash_bps: number;
      fee_bps: number;
      min_chaos_deposit: string;
      intents_account: string;
      max_vault_total: string;
    };
    result: undefined;
  };
  /**
   * Plant `headline` at `target` in an open duel. `kind` is the side the headline's lie pushes
   *  toward; `Placebo` (neutral) is the control arm and only the contract owner injects it, with
   *  no price. The deposit must reach `chaos_fee(duel_id)`; less the record's storage it is the
   *  stake, escrowed in the pool until the duel finishes. When the payer owns either agent the
   *  stake goes to `owner_fees` instead, earns nothing and buys no shield (as does a placebo).
   *  The arm is drawn here; `sha256(headline)` is listed in `Duel.injections`. Returns the
   *  injection's index in `get_chaos(duel_id)`.
   *  Caller: anyone (spectator); the owner for a placebo. Deposit: at least `chaos_fee` and the
   *  record's storage. Panics: "paused", "headline empty", "headline too long", "headline control
   *  character", "placebo is system-run", "duel missing", "chaos deposit too small", "duel
   *  closed", "bad target", "chaos full".
   * modifiers: payable
   */
  inject_chaos: { args: { duel_id: string; target: Base64VecU8; kind: ChaosKind; headline: string }; result: number };
  /**
   * Move the deploy-14 follower lists of agents `[cursor, cursor + limit)` (in `agents` order)
   *  into per-pair records, emitting a `follow` event for each so an indexer can backfill.
   *  Returns the next cursor, or `None` when every agent is done (follow and settle reopen).
   *  Each agent costs one read of its old list, which is what every settle used to do.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "migration done".
   * modifiers: payable
   */
  migrate_follows: { args: { limit: number }; result: number | null };
  /**
   * Pair two registered, idle agents on an oracle asset. Attached deposit must cover the duel's
   *  storage plus `oracle_deposit`; the open price is requested from the oracle in the same call
   *  and lands through `oracle_on_call`. Returns the duel id.
   *  Caller: owner. Deposit: at least the duel record's storage plus `oracle_deposit`; the excess
   *  is refunded. Panics: "not owner", "consent required", "paused", "set_oracle first",
   *  "same agent", "symbol too long", "close_at in the past", "duel too short", "duel too long",
   *  "agent missing", "in duel", "deposit too small".
   * modifiers: payable
   */
  open_duel: { args: { a: Base64VecU8; b: Base64VecU8; symbol: string; close_at: string }; result: string };
  /**
   * `open_duel` with both agents' consent: `sig_a` and `sig_b` are each agent key's ed25519
   *  signature over `consent_message(a, b, symbol, close_at)`. Anyone holding both signatures
   *  may open it; a consent cannot be replayed because `close_at` has passed by the time either
   *  agent is free again. Works whether or not `require_consent` is on.
   *  Caller: anyone. Deposit: as `open_duel`. Panics: "bad consent signature", then as
   *  `open_duel` minus "not owner" / "consent required".
   * modifiers: payable
   */
  open_duel_consented: {
    args: { a: Base64VecU8; b: Base64VecU8; symbol: string; close_at: string; sig_a: Base64VecU8; sig_b: Base64VecU8 };
    result: string;
  };
  /**
   * Outlayer delivers the price here. `msg` is `open:<id>` or `close:<id>` as sent by
   *  `ask_oracle`; `sender_id` is who called `oracle_call` and must be this contract. An open price
   *  is taken only when stamped within the oracle's recency window before `open_at` and at most
   *  ten minutes after it (and before `close_at`), so a late answer cannot set a wrong open price.
   *  Caller: `oracle_account` only. Deposit: none. Panics: "not oracle", "not our request",
   *  "bad msg", "duel missing", "no price", "price overflow", "bad price", "resolved",
   *  "open price stale", "duel open", "price before close", "no open price".
   */
  oracle_on_call: { args: { sender_id: string; data: PriceData; msg: string }; result: undefined };
  /**
   * Record an agent-signed intent for an open duel. Anyone may relay it: the signature is what
   *  binds the decision to the agent and the agent's bond pays its storage. Refused inside the
   *  last `intent_lock_ns` of the duel (the value the duel was opened under). A TEE-backed agent must also present the model enclave's
   *  (kind 2) signature over the completion that produced the decision. The intent must outlive
   *  `close_at` and carry a nonce above the agent's last posted one in this duel, so a relayer
   *  cannot resurface an older decision.
   *  Caller: anyone (relayer). Deposit: none; storage is taken from the agent's bond. Panics:
   *  "paused", "agent_pk length", "proof_hash length", "bad size", "agent missing", "bad tee kind",
   *  "tee hash length", "unknown tee signer", "bad tee signature", "proof_hash mismatch",
   *  "proof used", "provider proof required", "tee proof required", "duel missing",
   *  "duel closed", "intent lock", "intent expired", "bad target", "nonce used", "stale nonce",
   *  "bad signature", "bond exhausted"; "commit first" while `commit_reveal` is on.
   */
  post_intent: { args: { signed: SignedIntent; tee: TeeProof | null }; result: undefined };
  /**
   * Add `accounts`' vaults to the pending sum. Accounts must be strictly ascending, within the
   *  page and across pages (each above the last account counted), so none is counted twice; list
   *  every holder in sorted order. Returns the pending sum. Caller: owner. Deposit: 1 yoctoNEAR.
   *  Panics: "not owner", "no reconcile", "too many accounts", "accounts not ascending".
   * modifiers: payable
   */
  reconcile_page: { args: { accounts: string[] }; result: string };
  /**
   * Recompute `vault_total` as the sum of `accounts`' vaults. `vaults` is not iterable, so the
   *  owner supplies every vault holder (from deposit events); this clears the drift deploys 15 and
   *  earlier left (follow storage not subtracted, pre-15 vaults not counted). Omitting a holder
   *  only undercounts, which loosens the cap the owner can set anyway; no NEAR moves. Returns the
   *  new total. For more than `MAX_RECONCILE` holders use `begin_reconcile`. Caller: owner.
   *  Deposit: 1 yoctoNEAR. Panics: "not owner", "too many accounts" (over `MAX_RECONCILE`),
   *  "duplicate account".
   * modifiers: payable
   */
  reconcile_vault_total: { args: { accounts: string[] }; result: string };
  /**
   * Register an agent. The attached deposit is its bond, minus the storage its record costs.
   *  `tee = true` commits the agent to a verified `TeeProof` on every intent. `register_sig` is
   *  `agent_pk`'s ed25519 signature over `register_message(caller)`, so nobody can squat a
   *  published key.
   *  Caller: anyone; the caller becomes the agent owner. Deposit: the bond, above the
   *  record's storage cost. Panics: "paused", "agent_pk length", "model_id too long", "agent exists",
   *  "bad register signature", "bond required".
   * modifiers: payable
   */
  register_agent: {
    args: { agent_pk: Base64VecU8; model_id: string; tee: boolean; register_sig: Base64VecU8 };
    result: AgentView;
  };
  /**
   * Stop `account_id` from settling. Its settles already in flight are rejected in the
   *  callback ("solver removed"). Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner",
   *  "not a solver".
   * modifiers: payable
   */
  remove_solver: { args: { account_id: string }; result: undefined };
  /**
   * Stop accepting intents proved by this enclave key; intents already accepted stand.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
   * modifiers: payable
   */
  remove_tee_signer: { args: { signer: Base64VecU8 }; result: undefined };
  /**
   * Ask the oracle again for a duel whose open price never arrived (TEE fetch failed or timed
   *  out). Anyone may call and attaches the oracle deposit (so nobody can spend the contract's
   *  balance on oracle fees); the oracle's refund stays with the contract.
   *  Caller: anyone. Deposit: `oracle_deposit`, excess refunded. Panics:
   *  "attach oracle_deposit", "duel missing", "has open price", "duel closed".
   * modifiers: payable
   */
  request_open_price: { args: { duel_id: string }; result: undefined };
  /**
   * Queue a vault withdrawal. `withdraw` pays it `withdraw_delay_s` later, so a solver that
   *  fronted a swap before this request can still settle it. One request at a time.
   *  Caller: the vault owner. Deposit: 1 yoctoNEAR. Panics: "Requires attached deposit of
   *  exactly 1 yoctoNEAR", "withdrawal already pending", "insufficient".
   * modifiers: payable
   */
  request_withdraw: { args: { amount: string }; result: undefined };
  /**
   * After `close_at`, anyone asks the oracle for the close price; the answer arrives in
   *  `oracle_on_call` and finishes the duel. The caller attaches the oracle deposit. The oracle
   *  request is detached: this call succeeds once the request is sent, and may be repeated if the
   *  oracle never answers.
   *  Caller: anyone. Deposit: `oracle_deposit`, excess refunded. Panics:
   *  "attach oracle_deposit", "duel missing", "resolved", "duel open", "no open price".
   * modifiers: payable
   */
  resolve_duel: { args: { duel_id: string }; result: undefined };
  /**
   * Open a commitment: the intent and salt must hash to the stored commitment for
   *  `(intent.duel_id, intent.agent_pk)`; then every `post_intent` check and effect applies,
   *  except that the reveal may land inside the intent lock (the decision was fixed when it was
   *  committed, before the lock) up to `close_at`. The commitment is deleted. The decision counts
   *  as made at its commit time, which is what decides planted headlines (see `Chaos`).
   *  Caller: anyone (relayer). Deposit: none; storage is taken from the agent's bond. Panics:
   *  "no commitment", "commitment mismatch", then as `post_intent` minus "intent lock" and
   *  "commit first".
   */
  reveal_intent: { args: { signed: SignedIntent; salt: Base64VecU8; tee: TeeProof | null }; result: undefined };
  /**
   * `inject_chaos` terms (see `ChaosConfig`). The price applies to later injections; `fee_bps`
   *  and `share_bps` decide the payouts of stakes already escrowed, so they may not change while
   *  a duel is open. Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "chaos r out of
   *  range" (outside 10_000..=40_000), "chaos cap below base" (cap under base or
   *  `min_chaos_deposit`), "bps out of range" (fee over 1_000 or share over 10_000), "duels open".
   * modifiers: payable
   */
  set_chaos_config: { args: { chaos: ChaosConfig }; result: undefined };
  /**
   * Turn commit-reveal on or off and set the no-reveal slash. With it on, `post_intent` is
   *  refused and intents go through `commit_intent` / `reveal_intent`. `enabled` may not change
   *  while a duel is open, so a running duel keeps the rules it was opened under; the bps may.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "bps out of range", "duels open".
   * modifiers: payable
   */
  set_commit_reveal: { args: { enabled: boolean; no_reveal_bps: number }; result: undefined };
  /**
   * Point at another price oracle account, change the deposit it needs, the duel length floor, or
   *  the intent lock (no intent in the last `intent_lock_s` of a duel; at most half the floor).
   *  While any duel is open the lock may only grow and the oracle account may not change; a duel
   *  keeps the lock it was opened under either way.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "intent_lock_s too large",
   *  "min_duel_s too large", "duels open".
   * modifiers: payable
   */
  set_oracle: {
    args: { oracle_account: string; oracle_deposit: string; min_duel_s: number; intent_lock_s: number };
    result: undefined;
  };
  /**
   * Kill switch. While paused: `register_agent`, `open_duel*`, `post_intent`, `commit_intent`,
   *  `inject_chaos`, `deposit`, `follow` and `settle_follow` panic "paused". Every exit stays
   *  open: `request_withdraw`, `withdraw`, `withdraw_token`, `withdraw_bond`, `unfollow`,
   *  `reveal_intent`, `resolve_duel`, `request_open_price`, `void_duel`, `withdraw_fees`.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
   * modifiers: payable
   */
  set_paused: { args: { paused: boolean }; result: undefined };
  /**
   * With `required` on, `open_duel` is refused and pairing needs both agents' signatures
   *  through `open_duel_consented`.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
   * modifiers: payable
   */
  set_require_consent: { args: { required: boolean }; result: undefined };
  /**
   * Cap on one account's vault, checked by `deposit`. Lowering it below a vault only stops that
   *  account's new deposits. Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
   * modifiers: payable
   */
  set_vault_account_cap: { args: { max_vault_per_account: string }; result: undefined };
  /**
   * Cap on `vault_total`, checked by `deposit`. Lowering it below the current total only stops
   *  new deposits. Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner".
   * modifiers: payable
   */
  set_vault_cap: { args: { max_vault_total: string }; result: undefined };
  /**
   * How long `withdraw` waits after `request_withdraw`; at least twice the solver's settle lag.
   *  Applies to requests made after the change. Caller: owner. Deposit: 1 yoctoNEAR. Panics:
   *  "not owner", "delay out of range" (outside 60..=604800 s).
   * modifiers: payable
   */
  set_withdraw_delay: { args: { withdraw_delay_s: number }; result: undefined };
  /**
   * Solver asks to be repaid for swaps it fronted for one follower of one agent. The swap
   *  outputs must already sit in this contract's balance on `intents_account`; this call reads
   *  that balance and `on_settle_follow` decides each fill. Nothing is written here.
   *  Caller: a registered solver. Deposit: none. Panics: "not solver", "paused", "migrating",
   *  "empty fills", "too many fills", "swap_tx length", "dry quote unsettleable",
   *  "token length". Per-fill outcomes: see `on_settle_follow`.
   */
  settle_follow: { args: { agent_pk: Base64VecU8; follower: string; fills: Fill[] }; result: unknown };
  /**
   * Send output nobody can claim (a fill refused after its swap landed, a gift) out of this
   *  contract's `intents_account` balance. Bounded to `balance - accounted - sweeping`, read through
   *  the same view the settle reads, so credited holdings are never touched.
   *  Caller: owner. Deposit: 1 yoctoNEAR (forwarded to `mt_transfer`). Panics: "not owner",
   *  "Requires attached deposit of exactly 1 yoctoNEAR", "zero amount".
   * modifiers: payable
   */
  sweep_surplus: { args: { token_id: string; receiver_id: string; amount: string }; result: unknown };
  /**
   * Revoke the caller's mandate for `agent_pk`; a no-op when there is none. Open while paused.
   *  Fills for intents accepted before now stay settleable for `withdraw_delay_s`; intents
   *  accepted from now on never settle against this mandate (see `apply_fill`).
   *  Caller: the follower. Deposit: none. Panics: "migrating".
   */
  unfollow: { args: { agent_pk: Base64VecU8 }; result: undefined };
  /**
   * Escape hatch when the oracle never answers: a day after `close_at`, anyone may free both
   *  agents, no slashing, no score. Recorded as a tie with no prices: the injections settle as on a
   *  tie (see `settle_records`) and what is left of the pool is split between the agents.
   *  Caller: anyone. Deposit: none. Panics: "duel missing", "resolved", "too early",
   *  "agent missing".
   */
  void_duel: { args: { duel_id: string }; result: undefined };
  /**
   * Pay a queued withdrawal once its delay has passed: `min(requested, vault now)`, since
   *  fills settled during the delay may have lowered the vault. The vault is debited before the
   *  transfer; `on_withdraw` re-credits it and restores the request if the transfer fails (a
   *  deleted account), so the NEAR never sits in the contract unassigned.
   *  Caller: the vault owner. Deposit: 1 yoctoNEAR. Panics: "Requires attached deposit of
   *  exactly 1 yoctoNEAR", "no pending withdrawal", "withdrawal delay not elapsed".
   * modifiers: payable
   */
  withdraw: { args: Record<string, never>; result: unknown };
  /**
   * Agent owner takes bond back. Refused while the agent is in an open duel.
   *  Caller: the agent owner. Deposit: 1 yoctoNEAR. Panics: "agent missing", "not owner",
   *  "in duel", "insufficient".
   * modifiers: payable
   */
  withdraw_bond: { args: { agent_pk: Base64VecU8; amount: string }; result: unknown };
  /**
   * Contract owner collects accrued settlement fees.
   *  Caller: owner. Deposit: 1 yoctoNEAR. Panics: "not owner", "insufficient" (nothing accrued).
   * modifiers: payable
   */
  withdraw_fees: { args: Record<string, never>; result: unknown };
  /**
   * Send the caller's credited output to their own account on `intents_account`. The holding
   *  is debited first; `on_withdraw_token` re-credits it if the transfer fails. Open while
   *  paused. Caller: a follower. Deposit: 1 yoctoNEAR (forwarded to `mt_transfer`). Panics:
   *  "Requires attached deposit of exactly 1 yoctoNEAR", "insufficient".
   * modifiers: payable
   */
  withdraw_token: { args: { token_id: string; amount: string }; result: unknown };
}
