// The home page's back layer: a field of small tiles whose top edge moves like a market. It is a preset animation,
// not live data, so the page moves at any hour with no network: the edge follows the recorded price of one real duel
// (data/replay.json), looped, with slow waves added. Pure functions of (column, row, time); the canvas is tiles-view.

/** A repeatable number in [0, 1) for a pair of integers. */
export function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Prices scaled to 0..1 (lowest to highest). A flat or empty series is a level line at one half. */
export function curveOf(prices: number[]): number[] {
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  if (!prices.length || hi === lo) return [0.5, 0.5];
  return prices.map((p) => (p - lo) / (hi - lo));
}

/** The curve read at any position: it runs forward then backward, so the loop has no jump. */
export function sample(curve: number[], u: number): number {
  const span = curve.length - 1;
  const phase = (((u % 2) + 2) % 2) * span;
  const x = phase > span ? 2 * span - phase : phase;
  const i = Math.min(span - 1, Math.floor(x));
  const a = curve[i] ?? 0.5;
  const b = curve[i + 1] ?? a;
  return a + (b - a) * (x - i);
}

/** Height of the edge in one column, 0 (bottom) to 1 (top), at time t in seconds. */
export function edge(curve: number[], col: number, cols: number, t: number): number {
  const price = sample(curve, (col / cols) * 0.7 + t * 0.012);
  const x = (col / cols) * 144;
  const waves =
    0.11 * Math.sin(x * 0.085 + t * 0.7) + 0.06 * Math.sin(x * 0.027 - t * 0.41) + 0.03 * Math.sin(x * 0.4 + t * 1.9);
  return Math.min(0.9, Math.max(0.1, 0.42 + (price - 0.5) * 0.3 + waves));
}

export type Hue = "edge" | "body" | "deep";
/** One dot of the field: how strong it is (0 to 1, which sets its size and opacity) and which colour family. */
export type Dot = { v: number; hue: Hue };

/**
 * The dot at one cell, or null for an empty cell. The edge is a soft band, not a line: strength falls away smoothly
 * above it (a short glow) and below it (the body), and weaker cells are also drawn less often, so the field fades
 * into the page through smaller, sparser dots instead of stopping at a hard border.
 */
export function dot(col: number, row: number, rows: number, e: number, t: number): Dot | null {
  const d = row - (1 - e) * (rows - 1);
  // each cell re-rolls at its own moment, so the field flickers without moving in step
  const roll = hash(col, row * 131 + Math.floor(t * 1.4 + hash(row, col) * 7));
  if (d < 0) {
    const glow = Math.exp(d / 3);
    if (glow > 0.03) return roll < glow ? { v: glow, hue: "edge" } : null;
    return roll < 0.0015 ? { v: 0.6, hue: "deep" } : null;
  }
  // how far down the body reaches, and how full it is, both rise and fall along the field
  const reach = rows * (0.22 + 0.12 * Math.sin(t * 0.33 + col * 0.011));
  const fill = 0.72 + 0.26 * Math.sin(t * 0.45 + col * 0.027) * Math.sin(row * 0.09 - t * 0.2);
  const v = Math.exp(-d / reach);
  if (roll >= fill * (0.25 + 0.75 * v)) return null;
  return { v, hue: d < 1.5 ? "edge" : v > 0.45 ? "body" : "deep" };
}

export const PULSE_EVERY_S = 14;
export const PULSE_FOR_S = 2.6;

/** The column a pulse is crossing at time t (it sweeps left to right every 14 s), or -1 between pulses. */
export function pulseCol(cols: number, t: number): number {
  const p = (((t % PULSE_EVERY_S) + PULSE_EVERY_S) % PULSE_EVERY_S) / PULSE_FOR_S;
  return p < 1 ? Math.floor(p * cols) : -1;
}
