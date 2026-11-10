// What GET /api/predict?duel= serves, built from plain view answers so bun test covers it without an RPC: every free
// prediction market of one duel (lib/predict.ts), each with whether the predict contract would take a call now. The
// test is the contract's own `still_open` (predict/src/lib.rs), run on the arena's views:
// - the duel market takes calls until the duel's midpoint, and never once now + duel_lock >= close_at;
// - a chaos market takes calls while the arena's `chaos_open` says so. An arena without that view (deploy 17) makes
//   the contract fall back to the record: open while it is `Pending`, closing at the reveal (`open_until_reveal`).
// A market nobody has called yet has no record in the predict contract. It is served with zero calls and the label the
// contract would store at its first call, so the page says who can steer a market before anyone calls it.
import type { Chaos, ChaosOpen, Duel } from "../lib/abi/arena";
import type { MarketView } from "../lib/abi/predict";
import { picksOf } from "../lib/predict";

/** A market as the page shows it: the contract's view (zero calls before the first one) and whether it is open now. */
export type Market = MarketView & { open: boolean };

/** The predict contract's bound (`max_injections`): 32 chaos markets per duel, plus the duel's own. */
export const MAX_INJECTIONS = 32;

/** `chaos_open` per Pending record's index (null: the arena answered none for it), or null for the whole duel when the
 *  arena has no `chaos_open` view. */
export type Opens = Map<number, ChaosOpen | null> | null;

/** Who can steer a market, as the contract records it at the first call. */
type Label = Pick<MarketView, "steered_by" | "open_until_reveal">;

/** The duel market first, then one market per chaos record (at most MAX_INJECTIONS), by index. */
export function marketsOf(
  duel: Duel,
  lock: string | null,
  chaos: Chaos[],
  opens: Opens,
  called: MarketView[],
  nowNs: bigint,
): Market[] {
  const have = new Map(called.map((m) => [m.index, m]));
  const market = (index: number | null, open: boolean, label: Label): Market => {
    const m = have.get(index);
    if (m) return { ...m, open: open && !m.settled };
    return {
      duel_id: duel.id,
      index,
      picks: picksOf(index).map((pick) => ({ pick, n: 0 })),
      total: 0,
      scored: 0,
      settled: false,
      outcome: null,
      ...label,
      open,
    };
  };
  const at = BigInt(duel.open_at);
  const close = BigInt(duel.close_at);
  const half = at + (close - at) / 2n;
  // 30 s margin: a body may be ~20 s old (caches + poll) and signing takes time; the contract stays the authority
  const margin = 30_000_000_000n;
  const duelOpen = !duel.resolved && lock !== null && nowNs + margin < half && nowNs + margin + BigInt(lock) < close;
  // the duel market's label, and a closed market's (never shown)
  const plain: Label = { steered_by: null, open_until_reveal: false };
  return [
    market(null, duelOpen, plain),
    ...chaos.slice(0, MAX_INJECTIONS).map((c, i) => {
      if (c.outcome !== "Pending") return market(i, false, plain);
      if (opens === null) return market(i, true, { steered_by: null, open_until_reveal: true });
      const o = opens.get(i) ?? null;
      return market(i, !!o?.open, { steered_by: o && !o.keyless ? o.owner : null, open_until_reveal: false });
    }),
  ];
}
