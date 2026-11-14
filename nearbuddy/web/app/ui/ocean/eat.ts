import { mayEat, type Resistance, tierOf } from "../../assets/ocean";

export type EatVerdict =
  | { ok: true; predator: Resistance; prey: Resistance; predatorTier: string; preyTier: string }
  | { ok: false; reason: "overlap_or_thin" };

/** Pure: whether A may be shown eating B under ADR 0014. */
export function eatVerdict(predator: Resistance, prey: Resistance): EatVerdict {
  if (!mayEat(predator, prey)) return { ok: false, reason: "overlap_or_thin" };
  return {
    ok: true,
    predator,
    prey,
    predatorTier: tierOf(predator),
    preyTier: tierOf(prey),
  };
}
