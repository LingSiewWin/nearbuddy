// The live stage's geometry: a buffer of price samples, the polyline they draw against the open price, and where the
// rope's marker sits between two live P&Ls. Display only: a match settles on the oracle's prices.

/** One price reading: `t` in ms since the epoch, `p` in USD. */
export type Sample = { t: number; p: number };

/** A last sample older than this is no price: a frozen number would read as a calm market. */
export const STALE_MS = 10_000;

/** `buf` with `s` appended when it is newer than the last sample, without the samples before `from`. */
export function push(buf: Sample[], s: Sample, from: number): Sample[] {
  const last = buf[buf.length - 1];
  const next = last && s.t <= last.t ? buf : [...buf, s];
  return next.filter((x) => x.t >= from);
}

export const fresh = (buf: Sample[], now: number): boolean => {
  const last = buf[buf.length - 1];
  return !!last && now - last.t < STALE_MS;
};

/** The samples as points in a `w` × `h` box: time `t0`..`t1` across, the open price on `baseline` at mid height, and
 *  the largest move from the open touching the top or bottom edge (at least 5 bps, so a flat market stays flat). */
export function points(
  buf: Sample[],
  open: number,
  t0: number,
  t1: number,
  w: number,
  h: number,
): { pts: [number, number][]; baseline: number } {
  const baseline = h / 2;
  const half = Math.max(...buf.map((s) => Math.abs(s.p - open)), open * 0.0005);
  const span = t1 - t0 || 1;
  return {
    baseline,
    pts: buf.map((s) => [((s.t - t0) / span) * w, baseline - ((s.p - open) / half) * baseline]),
  };
}

/** The rope marker's place from 0 to 1: 0.5 level, above it side A leads, a 50 bps lead reaches the end. */
export function rope(pnlA: number | null, pnlB: number | null): number | null {
  if (pnlA === null || pnlB === null) return null;
  return 0.5 + Math.min(0.5, Math.max(-0.5, (pnlA - pnlB) / 100));
}
