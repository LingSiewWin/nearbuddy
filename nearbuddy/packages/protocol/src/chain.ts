// Thin NEAR helpers shared by solver / demo. Keys come from near-cli legacy keychain files.
import { readFileSync } from "node:fs";
import { Account, FailoverRpcProvider, JsonRpcProvider, type KeyPairString, type Provider } from "near-api-js";
import { RpcError } from "near-api-js/rpc-errors";
import { NET, NETWORK_ID, type NetworkId } from "./network.ts";

export const RPC = process.env.NEAR_RPC ?? NET.rpc; // per-network default in network.ts; see .env.example
/** Public RPCs rate-limit per machine; views fail over to a second endpoint instead of failing the request. */
export const RPC_FALLBACK = process.env.NEAR_RPC_FALLBACK ?? NET.fallback;
export const CONTRACT = process.env.NEARBUDDY_CONTRACT ?? "nearbuddy-vault.testnet"; // clearinghouse vault: testnet only
export const provider =
  RPC_FALLBACK && RPC_FALLBACK !== RPC
    ? new FailoverRpcProvider([new JsonRpcProvider({ url: RPC }), new JsonRpcProvider({ url: RPC_FALLBACK })])
    : new JsonRpcProvider({ url: RPC });

const NET_ERROR_CODE =
  /^(E(CONN|PIPE|TIMEDOUT|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH)|UND_ERR|Connection|FailedToOpenSocket)/;
/** True when the endpoint failed rather than answered: HTTP 408/429/5xx left after near-api-js's own retries, a
 *  refused or dropped connection, a timeout. A node answer (any `RpcError`: InvalidNonceError, a contract panic,
 *  an unknown account) is never a transport error. */
export function isTransportError(e: unknown): boolean {
  if (!(e instanceof Error) || e instanceof RpcError) return false;
  const { cause, code, type } = e as { cause?: unknown; code?: unknown; type?: unknown };
  if (typeof cause === "number") return cause === 408 || cause === 429 || cause >= 500; // fetchJsonRpc's ProviderError
  if (type === "RetriesExceeded" || e.name === "TimeoutError" || e.name === "AbortError") return true;
  const c = code ?? (cause as { code?: unknown } | undefined)?.code; // Bun sets `code`; Node's fetch sets `cause.code`
  return typeof c === "string" ? NET_ERROR_CODE.test(c) : e.message === "fetch failed";
}

/** A provider for signing accounts: each call tries the endpoints in order and moves to the next one only after a
 *  transport error; anything else is rethrown as is. near-api-js's FailoverRpcProvider moves on after any error and
 *  throws a FailoverRpcError wrapping them all, which hides InvalidNonceError from `Account.signAndSendTransaction`,
 *  so a nonce clash between two processes sharing a key failed instead of being re-signed with a fresh nonce. */
export function sendFailover(providers: Provider[]): Provider {
  const [first] = providers;
  if (!first) throw new Error("sendFailover needs a provider");
  if (providers.length === 1) return first;
  return new Proxy(first, {
    get(target, prop, receiver) {
      const own = Reflect.get(target, prop, receiver);
      if (typeof own !== "function") return own;
      return async (...args: unknown[]) => {
        let last: unknown;
        for (const p of providers) {
          try {
            return await (p as unknown as Record<PropertyKey, (...a: unknown[]) => Promise<unknown>>)[prop]?.(...args);
          } catch (e) {
            if (!isTransportError(e)) throw e;
            last = e;
          }
        }
        throw last;
      };
    },
  });
}

/** Transactions whose receipts take seconds (an oracle yield inside open_duel) are dropped by some public RPCs
 *  with "Internal server error" while waiting; sends may use a different endpoint than views, and fall back to the
 *  second endpoint only on such transport errors. */
const SEND_RPC = process.env.NEAR_SEND_RPC ?? RPC;
const sendProvider = sendFailover(
  [...new Set([SEND_RPC, RPC_FALLBACK].filter(Boolean))].map((url) => new JsonRpcProvider({ url })),
);

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

/** `Mandate.min_out_per_near` from a price: output units per NEAR in, `keepBps` of the quoted rate (9500 = accept up
 *  to 5 % worse). `amountIn` is yoctoNEAR, `amountOut` the output token's smallest units, e.g. a 1Click quote's legs.
 *  Deploy 15 refuses a follow without a floor; at least 1 so a tiny quote never yields 0. */
export function priceFloor(amountIn: bigint, amountOut: bigint, keepBps = 9500n): bigint {
  if (amountIn <= 0n) throw new Error("priceFloor: amountIn must be positive");
  const floor = (amountOut * NEAR * keepBps) / (amountIn * 10_000n);
  return floor > 0n ? floor : 1n;
}

/** Deposit for the arena's owner and exit calls (`withdraw_bond`, admin setters): exactly 1 yocto from deploy 15,
 *  none before, where those methods are not payable and refuse any deposit. */
export async function exitDeposit(view: ArenaView = arenaView): Promise<bigint> {
  return (await isDeploy15(view)) ? 1n : 0n;
}
