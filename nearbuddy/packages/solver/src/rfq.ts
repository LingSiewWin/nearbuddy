// One RFQ per agent per tick. At an agent's intent the solver asks 1Click for ONE dry quote sized at the sum of
// every open follower mandate and splits the output pro rata. Every follower gets the same price: CoW Protocol's
// uniform directed clearing price, applied to a batch of followers of one agent. Why one price:
//   - no intra-tick ordering game: the first follower quoted cannot get a better price than the last, so there is
//     nothing to gain from being early, from splitting a mandate, or from the solver choosing an order;
//   - the RFQ shows the market makers one size, not each follower's;
//   - one quote per intent instead of one per follower (1Click rate limits, one `timestamp` to report).
import { arenaView } from "../../protocol/src/chain.ts";
import type { Quote } from "./oneclick.ts";

export interface BatchFill {
  follower: string;
  amount: string;
  /** This follower's share of the quote output, base units. Absent when the batch failed. */
  quote_out?: string;
  error?: string;
}
export interface BatchQuote {
  amount_in_total: string;
  quote_out_total: string;
  /** Output per input in display units (`amountOutFormatted / amountInFormatted`); the same for every follower. */
  price: number;
  timestamp: string;
  deadline: string;
  quote?: Quote;
  fills: BatchFill[];
}

/** Split `out` over `amounts` pro rata. Integer floors, the remainder (< amounts.length base units) goes to the
 *  largest amount (first on a tie), so the parts always sum to exactly `out`: never over-allocated. */
export function proRata(amounts: bigint[], out: bigint): bigint[] {
  const total = amounts.reduce((s, a) => s + a, 0n);
  if (total === 0n) return amounts.map(() => 0n);
  const parts = amounts.map((a) => (out * a) / total);
  let largest = 0;
  for (let i = 1; i < amounts.length; i++) if (amounts[i]! > amounts[largest]!) largest = i;
  parts[largest]! += out - parts.reduce((s, p) => s + p, 0n);
  return parts;
}

export function quotePrice(q: Quote): number {
  return Number(q.quote.amountOutFormatted) / Number(q.quote.amountInFormatted);
}

/** One quote for the sum of `followers`' amounts, split pro rata. A failed or empty batch fills nobody: every
 *  follower carries the same `error`, never a partial allocation. */
export async function batchQuote(
  followers: { follower: string; amount: bigint }[],
  quoteFn: (amount: bigint) => Promise<Quote>,
): Promise<BatchQuote> {
  if (followers.some((f) => f.amount < 0n)) throw new Error("negative follower amount");
  const total = followers.reduce((s, f) => s + f.amount, 0n);
  const failed = (error: string): BatchQuote => ({
    amount_in_total: total.toString(),
    quote_out_total: "0",
    price: 0,
    timestamp: "",
    deadline: "",
    fills: followers.map((f) => ({ follower: f.follower, amount: f.amount.toString(), error })),
  });
  if (total === 0n) return failed("zero total: nothing to quote");
  let q: Quote;
  try {
    q = await quoteFn(total);
  } catch (e) {
    return failed(String(e).slice(0, 200));
  }
  const out = BigInt(q.quote.amountOut);
  const parts = proRata(
    followers.map((f) => f.amount),
    out,
  );
  return {
    amount_in_total: total.toString(),
    quote_out_total: out.toString(),
    price: quotePrice(q),
    timestamp: q.timestamp,
    deadline: q.quote.deadline ?? q.quoteRequest.deadline,
    quote: q,
    fills: followers.map((f, i) => ({
      follower: f.follower,
      amount: f.amount.toString(),
      quote_out: parts[i]!.toString(),
    })),
  };
}

// ---- execution quality ------------------------------------------------------------------------------------------
// Every fill the solver prepares is compared against the oracle mid (Outlayer, the price the duel is scored on),
// so the page can show slippage per fill. Units (the web reads these): amount_in yocto wNEAR, quote_out USDC base
// units (6 dp), oracle_mid USD x 1e8 (the contract's `open_price` scale), all decimal strings; quoted_at ms epoch;
// bps_vs_oracle a number, positive = the follower receives more USDC than the oracle mid would give.

export interface OracleMid {
  /** NEAR/USD x 1e8, decimal string. */
  mid: string;
  /** `outlayer_close`, `outlayer_open` (the duel's own oracle) or `coinbase_spot` (fallback). */
  source: string;
}
export interface ExecutionRecord {
  follower: string;
  intent_nonce: string;
  amount_in: string;
  quote_out: string;
  oracle_mid: string;
  quoted_at: number;
  bps_vs_oracle: number;
  agent_pk: string;
  duel_id: string;
  oracle_source: string;
}
export const MAX_EXECUTION = 200;

/** The quotes are always wNEAR -> USDC, so only a NEAR/USD oracle is a valid mid. */
export function duelMid(
  duel: { symbol?: string; open_price?: string | null; outcome?: { close_price: string } | null } | null,
): OracleMid | null {
  if (duel?.symbol !== "wrap.near") return null;
  if (duel.outcome) return { mid: duel.outcome.close_price, source: "outlayer_close" };
  if (duel.open_price) return { mid: duel.open_price, source: "outlayer_open" };
  return null;
}

/** NEAR/USD for an execution record: the duel's latest Outlayer price, else Coinbase spot (labelled), else null. */
export async function oracleMid(duel_id: string, fetchFn: typeof fetch = fetch): Promise<OracleMid | null> {
  try {
    const m = duelMid(await arenaView<Parameters<typeof duelMid>[0]>("get_duel", { duel_id }));
    if (m) return m;
  } catch {
    /* fall through to spot */
  }
  try {
    const r = await fetchFn("https://api.coinbase.com/v2/prices/NEAR-USD/spot", { signal: AbortSignal.timeout(3000) });
    const usd = Number(((await r.json()) as { data?: { amount?: string } }).data?.amount);
    return r.ok && usd > 0 ? { mid: String(Math.round(usd * 1e8)), source: "coinbase_spot" } : null;
  } catch {
    return null;
  }
}

/** Fill price vs mid in bps (2 dp) from base units: fill price x 1e8 = quote_out (6 dp) * 1e26 / amount_in (24 dp). */
export function bpsVsOracle(amount_in: bigint, quote_out: bigint, mid8: bigint): number | null {
  if (amount_in <= 0n || mid8 <= 0n) return null;
  // (quote_out * 1e26 / amount_in / mid8 - 1) * 1e8 = bps x 1e4, then rounded to 2 dp
  return Math.round(Number((quote_out * 10n ** 34n) / (amount_in * mid8) - 10n ** 8n) / 100) / 100;
}

/** One record per quoted follower. Errored followers are skipped (nothing was prepared for them), and so is every
 *  follower when there is no mid: a missing record beats a null `bps_vs_oracle` the page must special-case. */
export function executionRecords(
  intent: { agent_pk: string; duel_id: string; nonce: string },
  quotes: { follower: string; amount: string; quote?: Quote; quote_out?: string }[],
  mid: OracleMid | null,
): ExecutionRecord[] {
  if (!mid) return [];
  return quotes.flatMap((q) => {
    if (!q.quote || q.quote_out === undefined) return [];
    const bps = bpsVsOracle(BigInt(q.amount), BigInt(q.quote_out), BigInt(mid.mid));
    if (bps === null) return [];
    return [
      {
        follower: q.follower,
        intent_nonce: intent.nonce,
        amount_in: q.amount,
        quote_out: q.quote_out,
        oracle_mid: mid.mid,
        quoted_at: Date.parse(q.quote.timestamp),
        bps_vs_oracle: bps,
        agent_pk: intent.agent_pk,
        duel_id: intent.duel_id,
        oracle_source: mid.source,
      },
    ];
  });
}
