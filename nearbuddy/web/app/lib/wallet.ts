// NEAR wallet for the browser through the NEAR Connect connector (@hot-labs/near-connect): one connector per tab,
// loaded on first use so the terminal renders before any wallet code arrives. Network = this build's NEAR network.
// Creating the connector fetches its wallet list (a manifest on raw.githubusercontent.com), so a visit that never
// connected creates none: `account` answers null and `onChange` waits until something else created it.
import type { NearConnector } from "@hot-labs/near-connect";
import { NETWORK_ID } from "../network";
import type { Call } from "./inject";

let connector: Promise<NearConnector> | null = null;
const listeners = new Set<(account: string | null) => void>();
const get = () => {
  connector ??= import("@hot-labs/near-connect").then(({ NearConnector }) => {
    const c = new NearConnector({ network: NETWORK_ID, cspNonce: cspNonce() });
    c.on("wallet:signIn", (e) => {
      for (const cb of listeners) cb(e.accounts[0]?.accountId ?? null);
    });
    c.on("wallet:signOut", () => {
      for (const cb of listeners) cb(null);
    });
    return c;
  });
  return connector;
};

/** The page's CSP nonce (web/proxy.ts), off a script Next stamped with it. NEAR Connect puts it on the inline scripts
 *  of the sandboxed iframe it runs a wallet in: a srcdoc iframe inherits the page's policy, so without it the wallet
 *  never starts. */
const cspNonce = () => document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";

/** NEAR Connect's own record of the wallet a previous visit connected (its LocalStorage key "selected-wallet"). */
const remembered = () => {
  try {
    return localStorage.getItem("selected-wallet") !== null;
  } catch {
    return false;
  }
};

/** The signed-in account, or null; never opens a popup, and never loads the connector for a visitor who has not
 *  connected before. */
export async function account(): Promise<string | null> {
  if (!connector && !remembered()) return null;
  try {
    const { accounts } = await (await get()).getConnectedWallet();
    return accounts[0]?.accountId ?? null;
  } catch {
    return null;
  }
}

/** Opens the wallet picker; resolves with the account once the user signs in. */
export async function signIn(): Promise<string | null> {
  const c = await get();
  const wallet = await c.connect();
  return (await wallet.getAccounts())[0]?.accountId ?? null;
}

export async function signOut(): Promise<void> {
  await (await get()).disconnect();
}

/** Calls back on sign-in and sign-out from any wallet (another tab, the wallet's own UI) once the connector exists;
 *  resolves with the unsubscribe. */
export async function onChange(cb: (account: string | null) => void): Promise<() => void> {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Signs and sends one function call with the connected wallet; resolves with the transaction hash. */
export async function send(call: Call): Promise<string> {
  return (await sendFor(call)).hash;
}

/** `send`, also resolving with what the call returned: the outcome's `SuccessValue` read as JSON, undefined when the
 *  wallet handed back none (or the method returns nothing). */
export async function sendFor(call: Call): Promise<{ hash: string; value: unknown }> {
  const wallet = await (await get()).wallet();
  const out = await wallet.signAndSendTransaction({
    receiverId: call.receiverId,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: call.methodName, args: call.args, gas: call.gas, deposit: call.deposit },
      },
    ],
  });
  const hash = (out as { transaction?: { hash?: string } } | undefined)?.transaction?.hash;
  if (!hash) throw new Error("the wallet returned no transaction hash");
  const why = refusal(out);
  if (why) throw new Error(`the contract refused it (${why}) · tx ${hash.slice(0, 10)}…`);
  return { hash, value: returned(out) };
}

/** A successful outcome's return value (`status.SuccessValue`, base64 JSON), or undefined without one. */
export function returned(out: unknown): unknown {
  const v = ((out ?? {}) as { status?: { SuccessValue?: unknown } }).status?.SuccessValue;
  if (typeof v !== "string" || !v) return undefined;
  try {
    return JSON.parse(atob(v));
  } catch {
    return undefined;
  }
}

type Outcome = { status?: unknown; receipts_outcome?: { outcome?: { status?: unknown } }[] };
/** Why a sent transaction failed (the panic message when there is one), or null when it and every receipt succeeded.
 *  Wallets hand the RPC's FinalExecutionOutcome back as is, so a contract panic ("duel closed", "chaos full") arrives
 *  as a resolved promise and must be read from here. */
export function refusal(out: unknown): string | null {
  const o = (out ?? {}) as Outcome;
  const failure = [o.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome?.status)].find(
    (s) => typeof s === "object" && s !== null && "Failure" in s,
  ) as { Failure: unknown } | undefined;
  if (!failure) return null;
  const panic = JSON.stringify(failure.Failure).match(/"ExecutionError":"(?:Smart contract panicked: )?([^"]+)"/)?.[1];
  return panic ?? JSON.stringify(failure.Failure).slice(0, 120);
}
