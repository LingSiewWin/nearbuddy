// NEAR Intents 1Click client. Field names copied from the 1Click OpenAPI v0.1.10
// (https://1click.chaindefuser.com/docs/v0/openapi.yaml, read 2026-11-05). Mainnet only: there is
// no 1Click testnet. Dry quotes are free and keyless; without a partner key a real swap carries a
// 25 bps platform fee. `swap` is the only paid path and is never called by the arena loop.
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
