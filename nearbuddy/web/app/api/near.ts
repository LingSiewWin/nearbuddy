// Shared by the API routes: one public-RPC provider, contract views, and the JSON response shape.
import { FailoverRpcProvider, JsonRpcProvider } from "near-api-js";
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

export const viewOn = (contractId: string) => (method: string, args: Record<string, unknown>) =>
  provider.callFunction({ contractId, method, args });

/** near-api-js returns bigint in some view responses; stringify them. */
export const jsonBody = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
export const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
