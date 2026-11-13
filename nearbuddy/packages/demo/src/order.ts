// One real purchase with no human signature: a NEAR account pays in NEAR, NEAR Intents settles USDC on Base,
// and the payer buys a Bitrefill voucher over x402. Mainnet money, real voucher.
//   bun run order                 # KFC Malaysia RM5 voucher (about 1.31 USDC)
//   bun run order <product> <package_value>
// Requires ONECLICK_ACCOUNT (a funded mainnet account whose key is in ~/.near-credentials/mainnet/).
// ORDER_MAX_NEAR (default 1) is the most wNEAR one run may deposit.
//
// Who holds the USDC and signs the payment:
// - default: a local EVM key in .secrets/order-payer.key. Whoever has that file can spend all of it.
// - PAYGATE=<contract> PAYGATE_AGENT=<account>: the paygate contract (nearbuddy/paygate) on NEAR testnet. Its key
//   is derived by Chain Signatures and it signs only inside the owner's policy (cap, allowance, payees, expiry).
//   The agent's key is read from .secrets/paygate-agent.key and can be a function-call key. A purchase the policy
//   refuses fails on chain before any NEAR is swapped.
// The voucher is written to .secrets/order-<invoice>.json and never printed.
import "../../protocol/src/env.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import type { Hex } from "viem";
import type { Account as GateAccount, Policy } from "../../protocol/src/abi/paygate.ts";
import { loadKey, sendProvider } from "../../protocol/src/chain.ts";
import { NETWORK_ID, NETWORKS } from "../../protocol/src/network.ts";
import {
  connect,
  createInvoice,
  loadPayer,
  type Payer,
  payInvoice,
  usdcBalance,
  waitForInvoice,
} from "../../solver/src/bitrefill.ts";
import { buyUsdcOnBase, executeSwap } from "../../solver/src/oneclick.ts";
import { GateRefused, gateSigner } from "../../solver/src/paygate.ts";

const [product = "kfc-my", packageValue = "5"] = process.argv.slice(2);
const id = process.env.ONECLICK_ACCOUNT;
if (!id) throw new Error("set ONECLICK_ACCOUNT in the env file to a funded mainnet account");
const secrets = new URL("../../../.secrets/", import.meta.url).pathname;
const ceiling = BigInt(Math.round(Number(process.env.ORDER_MAX_NEAR ?? "1") * 1e6)) * 10n ** 18n;

// 1Click has no testnet, so the funding leg is mainnet whatever NEAR_NETWORK says.
const account = new Account(
  id,
  new JsonRpcProvider({ url: process.env.NEAR_MAINNET_RPC ?? NETWORKS.mainnet.rpc }),
  loadKey(id, "mainnet"),
);

async function gatedPayer(gate: string): Promise<Payer> {
  if (NETWORK_ID !== "testnet")
    throw new Error("the paygate contract is deployed on testnet: run with NEAR_NETWORK=testnet");
  const agentId = process.env.PAYGATE_AGENT;
  if (!agentId) throw new Error("set PAYGATE_AGENT to the account named in the paygate policy");
  const key = readFileSync(`${secrets}paygate-agent.key`, "utf8").trim() as KeyPairString;
  const owner = process.env.PAYGATE_OWNER;
  if (!owner) throw new Error("set PAYGATE_OWNER to the account that opened the paygate account");
  const opened = (await sendProvider.callFunction({
    contractId: gate,
    method: "get_account",
    args: { owner },
  })) as GateAccount | null;
  if (!opened) throw new Error(`no paygate account is open for ${owner}`);
  return gateSigner(new Account(agentId, sendProvider, key), gate, opened.payer as Hex, console.log) as Payer;
}
const gate = process.env.PAYGATE;
const payer = gate
  ? await gatedPayer(gate)
  : loadPayer(process.env.ORDER_PAYER_KEY_PATH ?? `${secrets}order-payer.key`);

const t0 = Date.now();
try {
  const token = await connect(payer);
  const invoice = await createInvoice(token, product, packageValue);
  const price = BigInt(invoice.price_usdc);
  console.log(
    `invoice ${invoice.invoice_id}: ${product} ${packageValue} for ${price} USDC units, payer ${payer.address}`,
  );

  if (gate) {
    // Ask the contract before any NEAR moves. A refusal is a failed transaction on NEAR, which is the evidence.
    const policy = (await sendProvider.callFunction({
      contractId: gate,
      method: "get_policy",
      args: {},
    })) as Policy | null;
    if (!policy || price > BigInt(policy.per_payment_cap) || price > BigInt(policy.allowance)) {
      console.log(`policy ${JSON.stringify(policy)} does not cover ${price}; asking the contract anyway, no swap`);
      await payInvoice(payer, invoice); // the contract refuses and this throws GateRefused
      throw new Error("the contract signed a payment its policy view does not cover");
    }
  }

  // Buy only what the payer is short of; a previous run can leave a few cents behind.
  const held = await usdcBalance(payer.address);
  const swap =
    held >= price
      ? undefined
      : await executeSwap(account, ceiling, console.log, buyUsdcOnBase(price - held, id, payer.address));
  for (let i = 0; i < 30 && (await usdcBalance(payer.address)) < price; i++)
    await new Promise((r) => setTimeout(r, 2_000));

  const tPay = Date.now();
  const paymentTx = await payInvoice(payer, invoice);
  console.log(`paid on Base: ${paymentTx} (${Date.now() - tPay} ms)`);
  const result = await waitForInvoice(token, invoice.invoice_id, console.log);
  const file = `${secrets}order-${invoice.invoice_id}.json`;
  writeFileSync(file, JSON.stringify(result, null, 2), { mode: 0o600 });

  console.log(
    JSON.stringify(
      {
        product,
        packageValue,
        invoice: invoice.invoice_id,
        status: result.status,
        delivered: JSON.stringify(result).includes("redemption_info"),
        priceUsdc: invoice.price_usdc,
        nearAccount: id,
        nearDepositTx: swap?.depositTx,
        wnearIn: swap?.quote.quote.amountIn,
        payer: payer.address,
        gate: gate ?? null,
        paymentTx,
        legs: { ...swap?.legs, total_ms: Date.now() - t0 },
        voucherFile: file,
      },
      null,
      2,
    ),
  );
  if (result.status !== "complete") process.exit(1);
} catch (e) {
  // x402 wraps the signer's error; find the contract's refusal inside it.
  let cause: unknown = e;
  while (cause && !(cause instanceof GateRefused)) cause = (cause as { cause?: unknown }).cause;
  const text =
    cause instanceof GateRefused ? cause.message : /paygate refused: [^\n]*/.exec(String((e as Error).message))?.[0];
  if (!text) throw e;
  console.log(
    JSON.stringify(
      { product, packageValue, refused: text, nearTx: cause instanceof GateRefused ? cause.nearTx : undefined },
      null,
      2,
    ),
  );
  process.exit(3);
}
