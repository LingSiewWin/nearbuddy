// NEAR wallet for the browser through the NEAR Connect connector (@hot-labs/near-connect): one connector per tab,
// loaded on first use so the terminal renders before any wallet code arrives. Network = this build's NEAR network.
import type { NearConnector } from "@hot-labs/near-connect";
import { NETWORK_ID } from "../network";
import type { Call } from "./inject";

let connector: Promise<NearConnector> | null = null;
const get = () => {
  connector ??= import("@hot-labs/near-connect").then(
    ({ NearConnector }) => new NearConnector({ network: NETWORK_ID }),
  );
  return connector;
};

/** The signed-in account, or null; never opens a popup. */
export async function account(): Promise<string | null> {
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

/** Calls back on sign-in and sign-out from any wallet (another tab, the wallet's own UI). */
export async function onChange(cb: (account: string | null) => void): Promise<() => void> {
  const c = await get();
  const inn = (e: { accounts: { accountId: string }[] }) => cb(e.accounts[0]?.accountId ?? null);
  const out = () => cb(null);
  c.on("wallet:signIn", inn);
  c.on("wallet:signOut", out);
  return () => {
    c.off("wallet:signIn", inn);
    c.off("wallet:signOut", out);
  };
}

/** Signs and sends one function call with the connected wallet; resolves with the transaction hash. */
export async function send(call: Call): Promise<string> {
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
  return hash;
}
