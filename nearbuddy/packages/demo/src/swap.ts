// One real NEAR Intents swap on mainnet, by hand, for the proof. Requires ONECLICK_ACCOUNT (a funded
// mainnet account whose key is in ~/.near-credentials/mainnet/) and spends SWAP_NEAR (default 0.5 NEAR).
//   bun run real-swap
import "../../protocol/src/env.ts";
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { executeSwap } from "../../solver/src/oneclick.ts";

const id = process.env.ONECLICK_ACCOUNT;
if (!id) throw new Error("set ONECLICK_ACCOUNT in the env file to a funded mainnet account");
const key = JSON.parse(readFileSync(`${process.env.HOME}/.near-credentials/mainnet/${id}.json`, "utf8")).private_key as KeyPairString;
const account = new Account(id, new JsonRpcProvider({ url: process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.near.org" }), key);
const amount = BigInt(Math.round(Number(process.env.SWAP_NEAR ?? "0.5") * 1e6)) * 10n ** 18n;
const r = await executeSwap(account, amount, console.log);
console.log(JSON.stringify({ status: r.status, amountOut: r.amountOut, depositTx: r.depositTx, deadline: r.quote.quote.deadline, legs: r.legs }, null, 2));
