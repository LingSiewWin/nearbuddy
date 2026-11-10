// Shared by the API routes: one public-RPC provider, contract views, and the JSON response shape.
import { FailoverRpcProvider, JsonRpcProvider } from "near-api-js";
import type { ArenaViews, Config } from "../lib/abi/arena";
import type { VaultViews } from "../lib/abi/vault";
import { NET } from "../network";

export const RPC = process.env.NEAR_RPC ?? NET.rpc; // NEAR_NETWORK picks the row in network.ts
export const CONTRACT = process.env.NEARBUDDY_CONTRACT ?? "nearbuddy-vault.testnet"; // clearinghouse vault: testnet only
export const ARENA = process.env.ARENA_CONTRACT ?? NET.arena;
export const SOLVER_URL = process.env.SOLVER_URL ?? "http://127.0.0.1:4020";
/** Public RPCs rate-limit per machine; views fail over to a second endpoint instead of failing the page. */
export const RPC_FALLBACK = process.env.NEAR_RPC_FALLBACK ?? NET.fallback;
export const provider =
  RPC_FALLBACK && RPC_FALLBACK !== RPC
    ? new FailoverRpcProvider([new JsonRpcProvider({ url: RPC }), new JsonRpcProvider({ url: RPC_FALLBACK })])
    : new JsonRpcProvider({ url: RPC });

/** Arena view; the method name picks args and result from the generated ABI types (abi/arena.json). */
export const arenaView = <M extends keyof ArenaViews>(method: M, args: ArenaViews[M]["args"]) =>
  provider.callFunction({ contractId: ARENA, method, args }) as Promise<ArenaViews[M]["result"]>;
/** Fields `get_config` gained over time. abi/arena.json describes the current source; an older arena omits them
 *  (commit-reveal and consent arrived by deploy 14; vault caps, pause and `intents_account` with deploy 15; the
 *  `chaos` price terms with deploy 17). */
type LateConfigField =
  | "chaos"
  | "commit_reveal"
  | "no_reveal_bps"
  | "require_consent"
  | "intents_account"
  | "max_vault_per_account"
  | "max_vault_total"
  | "migrating"
  | "paused"
  | "vault_total"
  | "withdraw_delay_s";
/** `get_config` as any deployed arena answers it. Code that supports older deploys reads this type, so tsc makes it
 *  handle every late field being absent. */
export type ArenaConfigAnyDeploy = Omit<Config, LateConfigField> & Partial<Pick<Config, LateConfigField>>;
export const arenaConfigAnyDeploy = (): Promise<ArenaConfigAnyDeploy> => arenaView("get_config", {});
/** Vault (clearinghouse) view, typed from abi/vault.json. */
export const vaultView = <M extends keyof VaultViews>(method: M, args: VaultViews[M]["args"]) =>
  provider.callFunction({ contractId: CONTRACT, method, args }) as Promise<VaultViews[M]["result"]>;
/** Arena views gone from the ABI that older deploys still answer: `list_followers` (deploy 14, see followers.ts). */
export const legacyArenaView = (method: "list_followers", args: { agent_pk: string }) =>
  provider.callFunction({ contractId: ARENA, method, args });

/** near-api-js returns bigint in some view responses; stringify them. */
export const jsonBody = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
export const json = (body: string, status = 200, cache = "no-store") =>
  new Response(body, { status, headers: { "content-type": "application/json", "cache-control": cache } });
