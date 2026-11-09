// Generated from abi/vault.json by packages/protocol/src/abi/gen.ts (bun run gen:types). Do not edit.

/** Base64 string on the wire (near-sdk's ABI reports Vec<u8>). */
export type Base64VecU8 = string;

export interface Config {
  fee_bps: number;
  max_batch: number;
  min_solver_stake: string;
  withdraw_delay_ns: string;
}

/** What a solver signs off-chain when a card is swiped. The issuer approves the card network authorization on the strength of this; the contract pays `payout` if the pull fails. Byte layout must match `packages/protocol/src/cert.ts`. */
export interface GuaranteeCert {
  /** Token units to pull (USDC: 6 dp). */
  amount: string;
  /** EIP-155 chain id of the pull (Sepolia = 11155111). */
  chain_id: number;
  /** Unix ns. Settlement must happen before this. */
  expires_at: string;
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
  issuer: string;
  nonce: string;
  /** yoctoNEAR the issuer receives from the reserve if the pull fails. */
  payout: string;
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
  solver: string;
  /** Token contract on the target chain, 0x-hex. */
  token: string;
  /** Payer wallet on the target chain, 0x-hex. */
  wallet: string;
}

/** The message an agent signs. Encoded with borsh, prefixed by `IOU_DOMAIN`. The TypeScript side (`packages/protocol`) must produce byte-identical output. */
export interface Iou {
  /** Agent public key (32 bytes, ed25519), base64 in JSON. */
  agent_pk: Base64VecU8;
  /** Amount in yoctoNEAR. */
  amount: string;
  /** Unix time in nanoseconds; settlement must happen before this. */
  expires_at: string;
  /** Unique per (agent_pk, nonce). Replay protection. */
  nonce: string;
  /** Vault owner who will be debited. */
  owner: string;
  /** Resource server that gets paid. */
  payee: string;
}

export interface IssuerReserve {
  /** Fees owed by the issuer for successful pulls. ponytail: accrued, invoiced off-chain. */
  fees_accrued: string;
  paid_out: string;
  pulls_failed: number;
  pulls_ok: number;
  /** yoctoNEAR of solver stake earmarked for this issuer. */
  reserved: string;
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
  solver: string;
}

export interface Mandate {
  /** Total yoctoNEAR the agent may ever spend under this mandate. */
  allowance: string;
  /** Empty = any payee. */
  allowed_payees: string[];
  /** Unix ns. IOUs cannot be settled after this. */
  expires_at: string;
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
  /** Max yoctoNEAR per single IOU. */
  per_tx_cap: string;
  revoked: boolean;
  /** Already settled under this mandate. */
  spent: string;
}

export interface PullOutcomePulled {
  tx_hash: string;
}

export interface PullOutcomePulledVariant {
  Pulled: PullOutcomePulled;
}

export interface PullOutcomeFailed {
  reason: string;
}

export interface PullOutcomeFailedVariant {
  Failed: PullOutcomeFailed;
}

export type PullOutcome = PullOutcomePulledVariant | PullOutcomeFailedVariant;

export interface PullReport {
  fees_accrued: string;
  paid_out: string;
  rejected: Rejected[];
  settled: number;
}

export interface PullSettlement {
  outcome: PullOutcome;
  signed: SignedCert;
}

export interface Rejected {
  index: number;
  reason: string;
}

export interface SettlementReport {
  /** Amount the solver's stake had to cover because a vault was short. */
  covered_by_solver: string;
  rejected: Rejected[];
  settled: number;
  solver_fee: string;
  total_paid: string;
}

export interface SignedCert {
  cert: GuaranteeCert;
  /** 64-byte ed25519 signature over `CERT_DOMAIN || borsh(cert)` by the solver's guarantee key. */
  signature: Base64VecU8;
}

export interface SignedIou {
  iou: Iou;
  /** 64-byte ed25519 signature over `IOU_DOMAIN || borsh(iou)`. */
  signature: Base64VecU8;
}

export interface Solver {
  fees_earned: string;
  ious_settled: number;
  stake: string;
}

export interface Vault {
  balance: string;
  /** Amount queued for withdrawal and the timestamp (ns) it becomes claimable. */
  pending_withdraw: [string, string] | null;
}

export interface VaultViews {
  /** Exposed so clients can check their cert encoding matches the contract's. */
  cert_message_hex: { args: { cert: GuaranteeCert }; result: string };
  contract_source_metadata: { args: Record<string, never>; result: unknown };
  get_config: { args: Record<string, never>; result: Config };
  get_guarantee_key: { args: { solver: string }; result: Base64VecU8 | null };
  get_issuer: { args: { issuer: string }; result: IssuerReserve | null };
  get_mandate: { args: { agent_pk: Base64VecU8 }; result: Mandate | null };
  get_solver: { args: { solver: string }; result: Solver | null };
  get_vault: { args: { owner: string }; result: Vault | null };
  /** Exposed so clients can check their encoding matches the contract's. */
  iou_message_hex: { args: { iou: Iou }; result: string };
  is_cert_nonce_used: { args: { solver: string; nonce: string }; result: boolean };
  is_nonce_used: { args: { agent_pk: Base64VecU8; nonce: string }; result: boolean };
}

export interface VaultCalls {
  /**
   * Lock NEAR in the caller's vault. Agents spend against this, never from it directly.
   * modifiers: payable
   */
  deposit: { args: Record<string, never>; result: Vault };
  /**
   * `fee_bps`: solver fee in basis points of settled volume (50 = 0.5%).
   *  `withdraw_delay_ns`: how long a withdrawal is queued so solvers can settle first.
   * modifiers: init
   */
  init: { args: { fee_bps: number; withdraw_delay_ns: string }; result: undefined };
  /**
   * Authorize an agent key to spend from the caller's vault within limits.
   *  Re-issuing for the same key replaces the mandate (spent resets to 0; nonces stay burned).
   */
  issue_mandate: {
    args: {
      agent_pk: Base64VecU8;
      allowance: string;
      per_tx_cap: string;
      allowed_payees: string[];
      expires_at: string;
    };
    result: Mandate;
  };
  /**
   * Stake NEAR to become a solver. Stake backs the IOUs you underwrite.
   * modifiers: payable
   */
  register_solver: { args: Record<string, never>; result: Solver };
  /** Move unused reserve back to free stake. */
  release_reserve: { args: { issuer: string; amount: string }; result: IssuerReserve };
  /**
   * Ask the NEAR MPC network to sign a foreign-chain transaction hash on behalf of this
   *  contract. `payload_hex` = 32-byte tx hash, `path` = derivation path (e.g. "sepolia-1").
   *  The derived foreign address is deterministic per (this contract, path). Solver-only.
   * modifiers: payable
   */
  request_pull_signature: { args: { payload_hex: string; path: string }; result: unknown };
  /**
   * Queue a withdrawal. Solvers stop accepting IOUs from this vault while one is pending,
   *  and have `withdraw_delay_ns` to settle what they already underwrote.
   */
  request_withdraw: { args: { amount: string }; result: Vault };
  /** Earmark `amount` of the caller's stake for `issuer`. Certs for this issuer draw on it. */
  reserve_for_issuer: { args: { issuer: string; amount: string }; result: IssuerReserve };
  revoke_mandate: { args: { agent_pk: Base64VecU8 }; result: undefined };
  /** Register the ed25519 key this solver signs guarantee certs with (32 raw bytes). */
  set_guarantee_key: { args: { pk: Base64VecU8 }; result: undefined };
  /**
   * Settle a batch of agent-signed IOUs in one transaction.
   *  Invalid IOUs are reported in `rejected`, never panic the whole batch.
   */
  settle_batch: { args: { ious: SignedIou[] }; result: SettlementReport };
  /**
   * Settle pull outcomes for signed certs. Callable by the cert's solver or its issuer, so the
   *  issuer can always enforce a guarantee itself. Failed pulls pay `payout` from the reserve to
   *  the issuer; successful pulls accrue the fee. Bad entries are rejected, never panic the batch.
   */
  settle_pull: { args: { settlements: PullSettlement[] }; result: PullReport };
  /** Withdraw stake (fees are credited to stake at settlement). */
  solver_withdraw: { args: { amount: string }; result: unknown };
  /**
   * Claim a queued withdrawal after the delay. Pays whatever is still in the vault
   *  (settlements during the delay may have reduced it).
   */
  withdraw: { args: Record<string, never>; result: unknown };
}
