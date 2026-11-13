// One sentence to a real order, no human signature: the model decides in an enclave, the paygate contract signs the
// payment inside the owner's policy, a NEAR account pays the shortfall in NEAR, NEAR Intents settles USDC on Base,
// and the payer buys a Bitrefill voucher over x402. Mainnet money, real voucher.
//   bun run buy "a KFC Malaysia RM5 voucher"
// Env: NEAR_AI_API_KEY, ORDER_MODEL, ONECLICK_ACCOUNT (a funded mainnet account whose key is in
// ~/.near-credentials/mainnet/), PAYGATE, PAYGATE_AGENT, PAYGATE_OWNER (testnet), ORDER_MAX_NEAR (default 1: the most
// wNEAR one run may deposit). The agent's key is read from .secrets/paygate-agent.key.
// ORDER_REPLAY=<receipt path> sends that receipt's recorded decision again instead of asking the model, to show the
// contract refusing a reused decision. It needs ORDER_REPLAY_COUNTRY; ORDER_REPLAY_QUERY defaults to the product id.
// The voucher goes to .secrets/order-<invoice>.json and is never printed. Receipts go to .orders/.
// Exit code: 0 delivered, 3 refused or asked, 1 failed.
import "../../protocol/src/env.ts";
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import type { Hex } from "viem";
import { NearAi } from "../../keeper/src/nearai.ts";
import type { Account as GateAccount } from "../../protocol/src/abi/paygate.ts";
import { loadKey, sendProvider } from "../../protocol/src/chain.ts";
import { b64 } from "../../protocol/src/index.ts";
import { NETWORK_ID, NETWORKS } from "../../protocol/src/network.ts";
import { type Payer, usdcBalance } from "../../solver/src/bitrefill.ts";
import { buyUsdcOnBase, executeSwap } from "../../solver/src/oneclick.ts";
import { gateSigner } from "../../solver/src/paygate.ts";
import { BitrefillRail } from "./bitrefill-rail.ts";
import { type OrderDeps, placeOrder, type Replay } from "./order.ts";
import type { Receipt } from "./receipt.ts";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name} in the env file`);
  return v;
};
const root = new URL("../../../", import.meta.url).pathname;

let replay: Replay | undefined;
let sentence = process.argv.slice(2).join(" ");
if (process.env.ORDER_REPLAY) {
  const old = JSON.parse(readFileSync(process.env.ORDER_REPLAY, "utf8")) as Receipt;
  const query = process.env.ORDER_REPLAY_QUERY ?? (old.decision.action === "buy" ? old.decision.productId : "");
  const country = need("ORDER_REPLAY_COUNTRY");
  if (!query) throw new Error("the recorded decision is not a buy: set ORDER_REPLAY_QUERY");
  const { model, proof } = old;
  replay = {
    model,
    proof,
    request: b64.strict(old.request_b64),
    response: b64.strict(old.response_b64),
    query,
    country,
  };
  sentence ||= old.sentence;
}
if (!sentence) throw new Error('usage: bun run buy "a KFC Malaysia RM5 voucher"');

if (NETWORK_ID !== "testnet")
  throw new Error("the paygate contract is deployed on testnet: run with NEAR_NETWORK=testnet");
const gate = need("PAYGATE");
const owner = need("PAYGATE_OWNER");
const agent = new Account(
  need("PAYGATE_AGENT"),
  sendProvider,
  readFileSync(`${root}.secrets/paygate-agent.key`, "utf8").trim() as KeyPairString,
);
const opened = (await sendProvider.callFunction({
  contractId: gate,
  method: "get_account",
  args: { owner },
})) as GateAccount | null;
if (!opened) throw new Error(`no paygate account is open for ${owner}`);
const payer = opened.payer as Hex;

// 1Click has no testnet, so the funding leg is mainnet whatever NEAR_NETWORK says.
const fundingId = need("ONECLICK_ACCOUNT");
const funding = new Account(
  fundingId,
  new JsonRpcProvider({ url: process.env.NEAR_MAINNET_RPC ?? NETWORKS.mainnet.rpc }),
  loadKey(fundingId, "mainnet"),
);
const ceiling = BigInt(Math.round(Number(process.env.ORDER_MAX_NEAR ?? "1") * 1e6)) * 10n ** 18n;

const deps: OrderDeps = {
  ai: new NearAi(need("NEAR_AI_API_KEY")),
  model: need("ORDER_MODEL"),
  rails: [new BitrefillRail()],
  gate,
  owner,
  payer,
  signer: (decision, log) => gateSigner(agent, gate, { owner, payer }, decision, log) as Payer,
  balance: usdcBalance,
  swap: (out) => executeSwap(funding, ceiling, console.log, buyUsdcOnBase(out, fundingId, payer)),
  secretsDir: `${root}.secrets`,
  ordersDir: `${root}.orders`,
  ...(replay && { replay }),
  log: console.log,
};

const receipt = await placeOrder(sentence, deps);
console.log(JSON.stringify(receipt, null, 2));
process.exit(receipt.status === "delivered" ? 0 : receipt.status === "failed" ? 1 : 3);
