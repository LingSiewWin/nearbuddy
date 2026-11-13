// Generated from abi/paygate.json by packages/protocol/src/abi/gen.ts (bun run gen:types). Do not edit.

export interface Account {
  /** The address the owner's derived key controls (`from` of every payment), 20 bytes hex with 0x. The owner supplies it; a wrong address only makes the owner's own signatures invalid on chain. */
  payer: string;
  policy: Policy | null;
}

/** Base64 string on the wire (near-sdk's ABI reports Vec<u8>). */
export type Base64VecU8 = string;

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
  admin: string;
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
  /** NEAR AI Cloud model ids whose enclave decisions may pay, e.g. "deepseek-ai/DeepSeek-V4.1-Flash-1017". */
  models: string[];
  /** Most token base units one payment may move. */
  per_payment_cap: string;
}

/** The NEAR AI Cloud signature record for one completion (same shape as the arena's `TeeProof`). The model's enclave signs the raw text `"{model_id}:{request_hash_hex}:{response_hash_hex}"` with ed25519. Only kind 2 (`provider_tee`, the model's own enclave) is accepted here. */
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

/** The EIP-712 domain of the token contract. */
export interface Token {
  /** Token contract, 20 bytes hex with 0x. */
  address: string;
  chain_id: string;
  /** `name()` of the token as its EIP-712 domain uses it, e.g. "USD Coin". */
  name: string;
  /** EIP-712 domain version, e.g. "2". */
  version: string;
}

export interface PaygateViews {
  contract_source_metadata: { args: Record<string, never>; result: unknown };
  get_account: { args: { owner: string }; result: Account | null };
  get_config: { args: Record<string, never>; result: Config };
  /** Whether the decision with this `proof_hash` (sha256 of request hash ‖ response hash) has paid. */
  is_decision_used: { args: { proof_hash: Base64VecU8 }; result: boolean };
  /** The EIP-712 digest `sign_payment` would sign for these fields, so a client can check its own encoding. */
  payment_digest_hex: {
    args: { owner: string; to: string; value: string; valid_after: string; valid_before: string; nonce: string };
    result: string;
  };
}

export interface PaygateCalls {
  /**
   * Admin only: accept decisions signed by this enclave key (32-byte ed25519). The admin takes it from the
   *  NEAR AI Cloud attestation report after verifying the report off chain.
   */
  add_tee_signer: { args: { signer: Base64VecU8 }; result: undefined };
  /** modifiers: init */
  new: { args: { admin: string; mpc_contract: string; token: Token }; result: undefined };
  /**
   * Open the caller's account. The caller becomes its owner; its key is derived with the caller's account id
   *  as path, and `payer` is the address of that key. The deposit (at least 0.01 NEAR, all of it kept) pays
   *  for the account's storage.
   * modifiers: payable
   */
  open_account: { args: { payer: string }; result: undefined };
  /** Admin only: stop accepting decisions signed by this enclave key. */
  remove_tee_signer: { args: { signer: Base64VecU8 }; result: undefined };
  /** Owner only: stop all signing for the caller's account. */
  revoke: { args: Record<string, never>; result: undefined };
  /** Owner only: replace the policy. The owner signs this with its own key, which the agent does not have. */
  set_policy: { args: { policy: Policy }; result: undefined };
  /**
   * Sign a sign-in message (EIP-191 `personal_sign`) as `owner`'s payer, so a shop can show the buyer its
   *  orders. Only a message that opens with the sign-in line of a domain in the policy is signed. Such a digest
   *  starts from the "\x19Ethereum Signed Message" prefix, so it can never be a payment authorization (0x1901).
   */
  sign_login: { args: { owner: string; message: string }; result: unknown };
  /**
   * Sign one EIP-3009 `transferWithAuthorization` from `owner`'s payer to `to`, if `decision` is a fresh
   *  decision of a policy model signed by a listed enclave and the payment fits the policy.
   *  Returns the MPC signature (`big_r`, `s`, `recovery_id`), or null when the MPC network did not sign,
   *  in which case the allowance and the decision are restored. A request outside the policy fails the
   *  transaction.
   */
  sign_payment: {
    args: {
      owner: string;
      to: string;
      value: string;
      valid_after: string;
      valid_before: string;
      nonce: string;
      model_id: string;
      decision: TeeProof;
    };
    result: unknown;
  };
}
