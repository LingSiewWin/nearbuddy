// Shared by the API routes: one public-RPC provider, contract views, and the JSON response shape.
import { FailoverRpcProvider, JsonRpcProvider } from "near-api-js";
import { NET } from "../network";

export const RPC = process.env.NEAR_RPC ?? NET.rpc; // NEAR_NETWORK picks the row in network.ts
export const CONTRACT = process.env.NEARBUDDY_CONTRACT ?? "nearbuddy-vault.testnet"; // clearinghouse vault: testnet only
export const ARENA = process.env.ARENA_CONTRACT ?? NET.arena;
export const SOLVER_URL = process.env.SOLVER_URL ?? "http://127.0.0.1:4020";
/** Public RPCs rate-limit per machine; views fail over to a second endpoint instead of failing the page. */
export const RPC_FALLBACK = process.env.NEAR_RPC_FALLBACK ?? NET.fallback;
// two quick retries, not near-api-js's default twelve (~85 s of backoff during a brownout)
const OPTS = { retries: 2, wait: 300, backoff: 1.5 };
export const provider =
  RPC_FALLBACK && RPC_FALLBACK !== RPC
    ? new FailoverRpcProvider([
        new JsonRpcProvider({ url: RPC }, OPTS),
        new JsonRpcProvider({ url: RPC_FALLBACK }, OPTS),
      ])
    : new JsonRpcProvider({ url: RPC }, OPTS);

const VIEW_TIMEOUT = 8_000;
export const viewOn = (contractId: string) => (method: string, args: Record<string, unknown>) =>
  Promise.race([
    provider.callFunction({ contractId, method, args }),
    new Promise<never>((_, no) => setTimeout(() => no(new Error(`view ${method} timed out`)), VIEW_TIMEOUT)),
  ]);

/** near-api-js returns bigint in some view responses; stringify them. */
export const jsonBody = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
export const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
/** JSON a CDN may share for `s` seconds and serve stale while it refreshes; errors are never cached. */
export const cachedJson = (body: string, s: number, status = 200) =>
  status === 200
    ? new Response(body, {
        status,
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=0, s-maxage=${s}, stale-while-revalidate=${s * 6}`,
        },
      })
    : json(body, status);
