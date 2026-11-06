// Thin NEAR helpers shared by solver / demo. Keys come from near-cli legacy keychain files.
import { readFileSync } from "node:fs";
import { Account, FailoverRpcProvider, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { NET, NETWORK_ID, type NetworkId } from "./network.ts";

export const RPC = process.env.NEAR_RPC ?? NET.rpc; // per-network default in network.ts; see .env.example
/** Public RPCs rate-limit per machine; views fail over to a second endpoint instead of failing the request. */
export const RPC_FALLBACK = process.env.NEAR_RPC_FALLBACK ?? NET.fallback;
export const CONTRACT = process.env.NEARBUDDY_CONTRACT ?? "nearbuddy-vault.testnet"; // clearinghouse vault: testnet only
export const provider =
  RPC_FALLBACK && RPC_FALLBACK !== RPC
    ? new FailoverRpcProvider([new JsonRpcProvider({ url: RPC }), new JsonRpcProvider({ url: RPC_FALLBACK })])
    : new JsonRpcProvider({ url: RPC });
/** Transactions whose receipts take seconds (an oracle yield inside open_duel) are dropped by some public RPCs
 *  with "Internal server error" while waiting; sends may use a different endpoint than views. */
const SEND_RPC = process.env.NEAR_SEND_RPC ?? RPC;
const sendProvider = SEND_RPC === RPC ? provider : new JsonRpcProvider({ url: SEND_RPC });

/** Signing key for `accountId`: `NEAR_KEY_<ACCOUNT_ID>` from the env, else the near-cli legacy keychain file
 *  under ~/.near-credentials/<network>/ (NEAR_NETWORK by default). */
export function loadKey(accountId: string, network: NetworkId = NETWORK_ID): KeyPairString {
  const envKey = process.env[`NEAR_KEY_${accountId.replace(/[.-]/g, "_").toUpperCase()}`];
  return (envKey ??
    JSON.parse(readFileSync(`${process.env.HOME}/.near-credentials/${network}/${accountId}.json`, "utf8"))
      .private_key) as KeyPairString;
}

export function loadAccount(accountId: string): Account {
  return new Account(accountId, sendProvider, loadKey(accountId));
}

export async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({ contractId: CONTRACT, method, args })) as T;
}

export interface Vault {
  balance: string;
  pending_withdraw: [string, string] | null;
}
export interface Mandate {
  owner: string;
  allowance: string;
  spent: string;
  per_tx_cap: string;
  allowed_payees: string[];
  expires_at: string;
  revoked: boolean;
}
export interface Solver {
  stake: string;
  fees_earned: string;
  ious_settled: number;
}
export interface SettlementReport {
  settled: number;
  total_paid: string;
  solver_fee: string;
  covered_by_solver: string;
  rejected: { index: number; reason: string }[];
}

export const getVault = (owner: string) => view<Vault | null>("get_vault", { owner });
export const getMandate = (agent_pk: string) => view<Mandate | null>("get_mandate", { agent_pk });
export const getSolver = (solver: string) => view<Solver | null>("get_solver", { solver });

export const NEAR = 10n ** 24n;
export const fmtNear = (yocto: string | bigint, digits = 5) => {
  const y = BigInt(yocto);
  const whole = y / NEAR;
  const frac = ((y % NEAR) * 10n ** BigInt(digits)) / NEAR;
  return `${whole}.${frac.toString().padStart(digits, "0")}`;
};
export const explorerTx = (hash: string) => `${NET.explorer}/txns/${hash}`;

// ---- arena -----------------------------------------------------------------------------------
export const ARENA = process.env.ARENA_CONTRACT ?? NET.arena;
export async function arenaView<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({ contractId: ARENA, method, args })) as T;
}
