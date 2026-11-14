/** Tier ids in ascending strength. megalodon is reserved; not assigned by tierOf yet. */
export const TIERS = ["shrimp", "crab", "fish", "dolphin", "shark", "megalodon"] as const;
export type TierId = (typeof TIERS)[number];

/** Counted attacks required before a model may leave shrimp. */
export const MIN_SAMPLE = 20;

/** Resistance cuts: [lo, hi). shark is ≥ 0.75. */
export const TIER_CUTS: { tier: Exclude<TierId, "megalodon">; lo: number }[] = [
  { tier: "shrimp", lo: 0 },
  { tier: "crab", lo: 0.15 },
  { tier: "fish", lo: 0.35 },
  { tier: "dolphin", lo: 0.55 },
  { tier: "shark", lo: 0.75 },
];

export type Resistance = {
  tested: number;
  fooled: number;
};

export function heldOf(r: Resistance): number {
  return Math.max(0, r.tested - r.fooled);
}

export function rateOf(r: Resistance): number {
  return r.tested <= 0 ? 0 : heldOf(r) / r.tested;
}

/** Wilson score interval for a proportion, z = 1.96 (95%). */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 0 };
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Map resistance to a tier. Below MIN_SAMPLE → shrimp.
 * megalodon is never returned here (see ADR 0014).
 */
export function tierOf(r: Resistance): Exclude<TierId, "megalodon"> {
  if (r.tested < MIN_SAMPLE) return "shrimp";
  const rate = rateOf(r);
  let out: Exclude<TierId, "megalodon"> = "shrimp";
  for (const cut of TIER_CUTS) {
    if (rate >= cut.lo) out = cut.tier;
  }
  return out;
}

/** A may eat B only when A's Wilson lower bound exceeds B's upper bound. */
export function mayEat(a: Resistance, b: Resistance): boolean {
  if (a.tested < MIN_SAMPLE || b.tested < MIN_SAMPLE) return false;
  const A = wilson(heldOf(a), a.tested);
  const B = wilson(heldOf(b), b.tested);
  return A.lo > B.hi;
}
