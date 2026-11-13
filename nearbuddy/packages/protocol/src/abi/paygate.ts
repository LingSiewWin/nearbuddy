// Generated from abi/paygate.json by packages/protocol/src/abi/gen.ts (bun run gen:types). Do not edit.

export interface Config {
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
  mpc_contract: string;
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
  path: string;
  token: Token;
}

export interface Policy {
  /** The only account that may ask for a signature. */
  agent: string;
  /** Token base units still spendable in total. Each signature reduces it. */
  allowance: string;
  /** Addresses that may be paid, 20 bytes hex with 0x. */
  allowed_payees: string[];
  /** Unix seconds after which nothing is signed. */
  expires_at: string;
  /** Sites the payer address may sign in to (`sign_login`), e.g. "api.bitrefill.com". */
  login_domains: string[];
  /** Most token base units one payment may move. */
  per_payment_cap: string;
}

/** The EIP-712 domain of the token contract, and the address this contract's derived key controls. */
export interface Token {
  /** Token contract, 20 bytes hex with 0x. */
  address: string;
  chain_id: string;
  /** `name()` of the token as its EIP-712 domain uses it, e.g. "USD Coin". */
  name: string;
  /** The derived address that holds the tokens (`from` of every payment), 20 bytes hex with 0x. */
  payer: string;
  /** EIP-712 domain version, e.g. "2". */
  version: string;
}

export interface PaygateViews {
  contract_source_metadata: { args: Record<string, never>; result: unknown };
  get_config: { args: Record<string, never>; result: Config };
  get_policy: { args: Record<string, never>; result: Policy | null };
  /** The EIP-712 digest `sign_payment` would sign for these fields, so a client can check its own encoding. */
  payment_digest_hex: {
    args: { to: string; value: string; valid_after: string; valid_before: string; nonce: string };
    result: string;
  };
}

export interface PaygateCalls {
  /** modifiers: init */
  new: { args: { owner: string; mpc_contract: string; path: string; token: Token }; result: undefined };
  /** Owner only: stop all signing. */
  revoke: { args: Record<string, never>; result: undefined };
  /** Owner only: replace the policy. The owner signs this with its own key, which the agent does not have. */
  set_policy: { args: { policy: Policy }; result: undefined };
  /**
   * Sign a sign-in message (EIP-191 `personal_sign`) as `payer`, so a shop can show the buyer its orders.
   *  Only a message that opens with the sign-in line of a domain in the policy is signed. Such a digest starts
   *  from the "\x19Ethereum Signed Message" prefix, so it can never be a payment authorization (0x1901).
   */
  sign_login: { args: { message: string }; result: unknown };
  /**
   * Sign one EIP-3009 `transferWithAuthorization` from `payer` to `to`, if the policy allows it.
   *  Returns the MPC signature (`big_r`, `s`, `recovery_id`), or null when the MPC network did not sign,
   *  in which case the allowance is restored. A request outside the policy fails the transaction.
   */
  sign_payment: {
    args: { to: string; value: string; valid_after: string; valid_before: string; nonce: string };
    result: unknown;
  };
}
