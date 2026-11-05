// NEAR Intents 1Click client. Field names copied from the 1Click OpenAPI v0.1.10
// (https://1click.chaindefuser.com/docs/v0/openapi.yaml, read 2026-11-05). Mainnet only: there is
// no 1Click testnet. Dry quotes are free and keyless; without a partner key a real swap carries a
// 25 bps platform fee. `swap` is the only paid path and is never called by the arena loop.
import { teraToGas, type Account } from "near-api-js";

export const ONECLICK_URL = process.env.ONECLICK_URL ?? "https://1click.chaindefuser.com";
export const ONECLICK_JWT = process.env.ONECLICK_JWT;
export const WNEAR = "nep141:wrap.near";
export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";
  slippageTolerance: number;          // basis points
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  amount: string;                     // base units
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  deadline: string;                   // ISO 8601
}
export interface Quote {
  correlationId?: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: {
    depositAddress?: string; deadline?: string; timeWhenInactive?: string;
    amountIn: string; amountInFormatted: string; amountInUsd: string; minAmountIn: string;
    amountOut: string; amountOutFormatted: string; amountOutUsd: string; minAmountOut: string;
    timeEstimate: number;
  };
}
export type SwapStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (ONECLICK_JWT) h["X-API-Key"] = ONECLICK_JWT;
  return h;
}

/** Quote a swap. `dry: true` costs nothing and returns no deposit address. */
export async function quote(req: QuoteRequest, fetchFn: typeof fetch = fetch): Promise<Quote> {
  const r = await fetchFn(`${ONECLICK_URL}/v0/quote`, { method: "POST", headers: headers(), body: JSON.stringify(req) });
  if (!r.ok) throw new Error(`1click quote ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as Quote;
}

/** Intent-sized request: sell `amountYocto` of wNEAR for USDC on NEAR, settled inside Intents. */
export function sellNearForUsdc(amountYocto: bigint, account: string, dry = true): QuoteRequest {
  return {
    dry, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: WNEAR, depositType: "INTENTS",
    destinationAsset: USDC_NEAR, amount: amountYocto.toString(), refundTo: account, refundType: "INTENTS",
    recipient: account, recipientType: "INTENTS", deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

/** Report the deposit for a non-dry quote, then poll status. Paid path: run by hand for the proof. */
export async function submitDeposit(txHash: string, depositAddress: string, fetchFn: typeof fetch = fetch): Promise<{ status: SwapStatus }> {
  const r = await fetchFn(`${ONECLICK_URL}/v0/deposit/submit`, { method: "POST", headers: headers(), body: JSON.stringify({ txHash, depositAddress }) });
  if (!r.ok) throw new Error(`1click submit ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as { status: SwapStatus };
}
export async function status(depositAddress: string, fetchFn: typeof fetch = fetch): Promise<{ status: SwapStatus; swapDetails?: Record<string, unknown> }> {
  const r = await fetchFn(`${ONECLICK_URL}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: headers() });
  if (!r.ok) throw new Error(`1click status ${r.status}`);
  return (await r.json()) as { status: SwapStatus; swapDetails?: Record<string, unknown> };
}

// ---- the one paid path ------------------------------------------------------------------------
// Real swap on mainnet: wrap NEAR, quote (non-dry, ORIGIN_CHAIN deposit), ft_transfer wNEAR to the
// quote's depositAddress, report the tx, poll until SUCCESS. Run by hand (`pnpm real-swap`), never by
// the arena loop. Needs a funded mainnet account in the legacy keychain.

export function sellNearForUsdcOnChain(amountYocto: bigint, account: string): QuoteRequest {
  return {
    dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: WNEAR, depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC_NEAR, amount: amountYocto.toString(), refundTo: account, refundType: "ORIGIN_CHAIN",
    recipient: account, recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

export interface SwapResult { quote: Quote; wrapTx: string; depositTx: string; status: SwapStatus; amountOut?: string }

export async function executeSwap(account: Account, amountYocto: bigint, log: (s: string) => void = () => {}): Promise<SwapResult> {
  const q = await quote(sellNearForUsdcOnChain(amountYocto, account.accountId));
  const dep = q.quote.depositAddress;
  if (!dep) throw new Error("quote has no depositAddress (dry?)");
  log(`quote ${q.quote.amountInFormatted} wNEAR -> ${q.quote.amountOutFormatted} USDC, deposit to ${dep}, deadline ${q.quote.deadline}`);
  // wrap: near_deposit mints wNEAR 1:1 (storage_deposit first in case the account is new to wrap.near)
  await account.callFunctionRaw({ contractId: "wrap.near", methodName: "storage_deposit", args: {}, gas: teraToGas("30"), deposit: 1_250_000_000_000_000_000_000n });
  const wrap = await account.callFunctionRaw({ contractId: "wrap.near", methodName: "near_deposit", args: {}, gas: teraToGas("30"), deposit: amountYocto });
  log(`wrapped ${amountYocto} yocto: ${wrap.transaction.hash}`);
  // the deposit address must hold a wNEAR storage slot before it can receive
  await account.callFunctionRaw({ contractId: "wrap.near", methodName: "storage_deposit", args: { account_id: dep }, gas: teraToGas("30"), deposit: 1_250_000_000_000_000_000_000n });
  const xfer = await account.callFunctionRaw({
    contractId: "wrap.near", methodName: "ft_transfer", args: { receiver_id: dep, amount: amountYocto.toString() }, gas: teraToGas("30"), deposit: 1n,
  });
  log(`ft_transfer to deposit address: ${xfer.transaction.hash}`);
  await submitDeposit(xfer.transaction.hash, dep);
  let st = await status(dep);
  for (let i = 0; i < 40 && !["SUCCESS", "REFUNDED", "FAILED"].includes(st.status); i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    st = await status(dep);
    log(`status ${st.status}`);
  }
  if (st.status !== "SUCCESS") throw new Error(`swap ended ${st.status} (deposit tx ${xfer.transaction.hash}); not a proof`);
  return { quote: q, wrapTx: wrap.transaction.hash, depositTx: xfer.transaction.hash, status: st.status, amountOut: (st.swapDetails as { amountOut?: string } | undefined)?.amountOut };
}
