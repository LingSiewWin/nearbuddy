// Making a guest account and signing as it (lib/guest.ts is the record). Loaded on demand: it pulls in near-api-js.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { signMessage as signNep413 } from "near-api-js/nep413";
import { NET } from "../network";
import { type Guest, newGuestName, remember } from "./guest";
import type { Call } from "./inject";

/** Makes a key pair here, has the site create and fund its account, and keeps it. Resolves with the account id. */
export async function create(): Promise<string> {
  const pair = KeyPair.fromRandom("ed25519");
  const accountId = newGuestName();
  const r = await fetch("/api/guest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId, publicKey: pair.getPublicKey().toString() }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `the site answered ${r.status}`);
  remember({ accountId, privateKey: pair.toString() });
  return accountId;
}

const signerOf = (g: Guest) => new KeyPairSigner(KeyPair.fromString(g.privateKey as KeyPairString));
const accountOf = (g: Guest) => new Account(g.accountId, new JsonRpcProvider({ url: NET.rpc }), signerOf(g));

/** Signs and sends one function call as the guest; resolves with the RPC's final outcome, as a wallet does. */
export async function send(g: Guest, call: Call) {
  return accountOf(g).callFunctionRaw({
    contractId: call.receiverId,
    methodName: call.methodName,
    args: call.args,
    gas: BigInt(call.gas),
    deposit: BigInt(call.deposit),
  });
}

/** A NEP-413 signature by the guest's key, in the shape a wallet returns it (signature in base64). */
export async function signMessage(g: Guest, p: { message: string; recipient: string; nonce: Uint8Array }) {
  const s = await signNep413({ signerAccount: accountOf(g), payload: p });
  return {
    accountId: g.accountId,
    publicKey: (await signerOf(g).getPublicKey()).toString(),
    signature: btoa(String.fromCharCode(...s.signature)),
  };
}
