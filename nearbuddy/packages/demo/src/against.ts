// Which payload the spectator sends: one that pushes AGAINST the duel's move so far. A payload that pushes the way
// the price is already moving tests nothing, because a momentum-following model lands on that side anyway.
// The move is the number the agents' brief shows ("Move since duel open", agents/prices.py brief()), taken from the
// open the runner briefs on: the duel's oracle open price (agents/runner.py oracle_open_px). A payload's side is what
// analysis/injection_effects.py pushed_side() reads from its text. against.fixture.json pins both, checked from
// TypeScript (against.test.ts) and through the runner's own code (agents/tests/test_spectator_against.py).

export type Side = "Long" | "Short";

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

/** Move since duel open in bps, as brief() computes it. `open8` is the duel's oracle open price (what
 *  oracle_open_px() hands brief()), `price8` the current spot, both 8 dp. */
export function moveBps(open8: number, price8: number): number {
  return ((price8 - open8) / open8) * 10_000;
}

/** brief()'s `{move:+.1f}`. Python rounds an exact binary tie (x.x5 with x*4 an odd integer: 0.25, 1.25, -0.75)
 *  half to even where `toFixed` rounds it up, and keeps the sign of -0.0 (fixtures/wire-vectors.json "move_format"). */
export function fmtMove(move: number): string {
  let s = move.toFixed(1);
  // below 2^49, move * 10 is exact; a basis-point move never gets near that
  if (Math.abs(move) < 2 ** 49 && Number.isInteger(move * 4) && !Number.isInteger(move * 2)) {
    const lo = Math.floor(move * 10); // move * 10 is exact here: an odd multiple of 2.5
    s = ((lo % 2 === 0 ? lo : lo + 1) / 10).toFixed(1);
  }
  const negative = move < 0 || Object.is(move, -0);
  return negative ? (s.startsWith("-") ? s : `-${s}`) : `+${s}`;
}

// Oracle asset id -> the symbol the runner prices (agents/chain.py ASSETS) and its Pyth feed (agents/prices.py FEEDS).
const SYMBOLS: Record<string, { coinbase: string; pyth: string }> = {
  "wrap.near": { coinbase: "NEAR", pyth: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750" },
};

/** agents/prices.py price(): Hermes when PYTH_API_KEY is set (falling back to Coinbase), else Coinbase spot. 8 dp. */
export async function spot8(asset: string): Promise<number> {
  const s = SYMBOLS[asset];
  if (!s) throw new Error(`no price source for ${asset}`);
  const key = process.env.PYTH_API_KEY;
  if (key) {
    try {
      const r = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${s.pyth}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) {
        const { price, expo } = ((await r.json()) as { parsed: { price: { price: string; expo: number } }[] })
          .parsed[0]!.price;
        const shift = 8 + expo;
        return Number(shift >= 0 ? BigInt(price) * 10n ** BigInt(shift) : BigInt(price) / 10n ** BigInt(-shift));
      }
    } catch {} // Coinbase below, as prices.py does
  }
  const r = await fetch(`https://api.coinbase.com/v2/prices/${s.coinbase}-USD/spot`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`coinbase ${r.status}`);
  const [whole, frac = ""] = ((await r.json()) as { data: { amount: string } }).data.amount.split(".");
  return Number(BigInt(whole!) * 100_000_000n + BigInt(`${frac}00000000`.slice(0, 8)));
}

/** Flat when the brief would show +0.0 / -0.0. */
export function isFlat(move: number): boolean {
  return Number(move.toFixed(1)) === 0;
}

export type Pick = { idx: number; mode: "against" | "flat"; push: Side | null };

/** The k-th pick for a duel whose move is `move` bps (null: no oracle open price yet, treated as flat). Against:
 *  rotate through the payloads pushing the opposite side (Long when the price fell, Short when it rose). Flat:
 *  rotate through the whole set, either side. */
export function pickPayload(payloads: readonly string[], move: number | null, k: number): Pick {
  if (move === null || isFlat(move)) return { idx: k % payloads.length, mode: "flat", push: null };
  const push: Side = move > 0 ? "Short" : "Long";
  const pool = payloads.flatMap((p, i) => (pushedSide(p) === push ? [i] : []));
  if (pool.length === 0) throw new Error(`no ${push} payload in the set`);
  return { idx: pool[k % pool.length]!, mode: "against", push };
}

/** The move as the log line and the on-chain kind show it: the brief's string, or "no_open" before the oracle's
 *  open price has landed. */
export function moveText(move: number | null): string {
  return move === null ? "no_open" : fmtMove(move);
}

/** inject_chaos `kind` for a pick: "fake_news/<against|flat>/<move>", at most 32 chars (arena/src/duels.rs). The web
 *  splits it on "/" (web/app/cells.ts kindCell), so no part may contain one. */
export function injectionKind(mode: Pick["mode"], move: number | null): string {
  const kind = `fake_news/${mode}/${moveText(move)}`;
  if (kind.length > 32) throw new Error(`kind over 32 chars: ${kind}`);
  return kind;
}
