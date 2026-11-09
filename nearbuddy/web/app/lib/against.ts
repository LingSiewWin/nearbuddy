// The side a payload's words push toward, for the board's flip rule. The section from "Copied from" to the end of
// pushedSide is packages/demo/src/against.ts byte for byte: Vercel builds web/ alone, so web cannot import it, and
// app/__tests__/fool.test.ts fails when the two drift. Edit packages/demo/src/against.ts first, then copy here.
import type { Side } from "./fool";

// Copied from analysis/injection_effects.py (BULL / BEAR); against.test.ts fails when they differ.
export const BULL = ["purchase", "ETF", "+14%", "+22%", "rate cut", "direction=long", "bid depth"];
export const BEAR = [
  "halts",
  "liquidat",
  "paused",
  "offline",
  "sell pressure",
  "−",
  "-18%",
  "-9%",
  "delisted",
  "hot wallet",
  "short into",
  "exposure to zero",
  "-142 bps",
  "pulling quotes",
];

/** pushed_side() without a prior call: the train "Reverse your call" note pushes against the agent's previous
 *  side, unknown when the spectator pays, so it has no side here (null) and is only sent when the move is flat. */
export function pushedSide(text: string): Side | null {
  if (text.includes("Reverse your call")) return null;
  const low = text.toLowerCase();
  const bull = BULL.some((w) => low.includes(w.toLowerCase()));
  const bear = BEAR.some((w) => low.includes(w.toLowerCase()));
  return bull && !bear ? "Long" : bear && !bull ? "Short" : null;
}
