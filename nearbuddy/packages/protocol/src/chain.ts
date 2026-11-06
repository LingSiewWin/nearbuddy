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

/** Mainnet startup check, read-only (one view_account, no tx). The mainnet ids in network.ts are defaults for
 *  accounts not claimed yet, so warn when the arena account does not exist. Returns true when it warned; an RPC
 *  error other than UNKNOWN_ACCOUNT says nothing about the account and stays silent. */
export async function warnIfArenaMissing(
  network: NetworkId = NETWORK_ID,
  arena = ARENA,
  rpc = RPC,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (network !== "mainnet") return false;
  try {
    const r = await fetchFn(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: arena },
      }),
    });
    const j = (await r.json()) as { error?: { cause?: { name?: string } } };
    if (j.error?.cause?.name !== "UNKNOWN_ACCOUNT") return false;
  } catch {
    return false;
  }
  console.warn(
    `[network] mainnet arena ${arena} does not exist (UNKNOWN_ACCOUNT on ${rpc}); create it or set ARENA_CONTRACT`,
  );
  return true;
}

type ArenaView = <T>(method: string, args: Record<string, unknown>) => Promise<T>;

/** Deploy 15 or later (verified settlement): `get_config` names the intents account. */
export async function isDeploy15(view: ArenaView = arenaView): Promise<boolean> {
  return typeof (await view<{ intents_account?: unknown }>("get_config", {})).intents_account === "string";
}

/** The exact bytes `register_agent` by `owner` verifies, from the contract's `register_message` view (v1 up to
 *  deploy 14, v2 with the contract id from deploy 15). The v1 bytes when the view cannot be read: a deploy-15
 *  contract then refuses the registration, it never accepts a wrong one. */
export async function registerMessage(owner: string, view: ArenaView = arenaView): Promise<Buffer> {
  try {
    return Buffer.from(await view<string>("register_message", { owner }), "base64");
  } catch {
    return Buffer.concat([Buffer.from("nearbuddy-register-v1"), Buffer.from(owner)]);
  }
}

/** Deposit for the arena's owner and exit calls (`withdraw_bond`, admin setters): exactly 1 yocto from deploy 15,
 *  none before, where those methods are not payable and refuse any deposit. */
export async function exitDeposit(view: ArenaView = arenaView): Promise<bigint> {
  return (await isDeploy15(view)) ? 1n : 0n;
}
