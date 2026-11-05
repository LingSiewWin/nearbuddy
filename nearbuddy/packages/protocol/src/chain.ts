// Thin NEAR helpers shared by solver / demo. Keys come from near-cli legacy keychain files.
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import type { Iou } from "./index.ts";

export const RPC = process.env.NEAR_RPC ?? "https://near-testnet.drpc.org"; // one default everywhere; see .env.example
export const CONTRACT = process.env.NEARBUDDY_CONTRACT ?? "nearbuddy-vault.testnet";
export const provider = new JsonRpcProvider({ url: RPC });

export function loadAccount(accountId: string): Account {
  const envKey = process.env[`NEAR_KEY_${accountId.replace(/[.-]/g, "_").toUpperCase()}`];
  const key =
    envKey ??
    (JSON.parse(
      readFileSync(`${process.env.HOME}/.near-credentials/testnet/${accountId}.json`, "utf8"),
    ).private_key as string);
  return new Account(accountId, provider, key as KeyPairString);
}

export async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({ contractId: CONTRACT, method, args })) as T;
}

export interface Vault { balance: string; pending_withdraw: [string, string] | null }
export interface Mandate {
  owner: string; allowance: string; spent: string; per_tx_cap: string;
  allowed_payees: string[]; expires_at: string; revoked: boolean;
}
export interface Solver { stake: string; fees_earned: string; ious_settled: number }
export interface SettlementReport {
  settled: number; total_paid: string; solver_fee: string; covered_by_solver: string;
  rejected: { index: number; reason: string }[];
}

export const getVault = (owner: string) => view<Vault | null>("get_vault", { owner });
export const getMandate = (agent_pk: string) => view<Mandate | null>("get_mandate", { agent_pk });
export const getSolver = (solver: string) => view<Solver | null>("get_solver", { solver });
export const iouMessageHexOnChain = (iou: Iou) => view<string>("iou_message_hex", { iou });

export const NEAR = 10n ** 24n;
export const fmtNear = (yocto: string | bigint, digits = 5) => {
  const y = BigInt(yocto);
  const whole = y / NEAR;
  const frac = ((y % NEAR) * 10n ** BigInt(digits)) / NEAR;
  return `${whole}.${frac.toString().padStart(digits, "0")}`;
};
export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

// ---- arena -----------------------------------------------------------------------------------
export const ARENA = process.env.ARENA_CONTRACT ?? "arena.nearbuddy-solver.testnet";
export async function arenaView<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({ contractId: ARENA, method, args })) as T;
}
