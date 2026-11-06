// One RFQ per agent per tick. At an agent's intent the solver asks 1Click for ONE dry quote sized at the sum of
// every open follower mandate and splits the output pro rata. Every follower gets the same price: CoW Protocol's
// uniform directed clearing price, applied to a batch of followers of one agent. Why one price:
//   - no intra-tick ordering game: the first follower quoted cannot get a better price than the last, so there is
//     nothing to gain from being early, from splitting a mandate, or from the solver choosing an order;
//   - the RFQ shows the market makers one size, not each follower's;
//   - one quote per intent instead of one per follower (1Click rate limits, one `timestamp` to report).
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
