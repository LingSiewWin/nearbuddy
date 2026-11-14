// Pure silhouettes in local space. x runs snout(0) → tail(1); y is across the body (−1..1).
// Original NearBuddy outlines; technique (cell raster + density ramp) follows the ascii-sharks family.
// Tuned for ASCII-grid readability: sharper edges, clearer fins, less muddy fill.

export type Part = "empty" | "body" | "fin" | "edge" | "eye";

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Classic shark half-width along the body (fraction of length). */
function sharkHalf(s: number): number {
  if (s < 0.1) return 0.09 * Math.pow(Math.sin(((s / 0.1) * Math.PI) / 2), 0.85);
  if (s < 0.28) return 0.09 + 0.045 * smoothstep(0.1, 0.28, s);
  if (s < 0.78) return 0.135 * Math.pow(1 - (s - 0.28) / 0.5, 1.05);
  const k = (s - 0.78) / 0.22;
  return 0.028 * (1 - k) + 0.02 * Math.sin(k * Math.PI);
}

/** Sample a shark at local (s, n). `wave` is a small body undulation. */
export function sampleShark(s: number, n: number, wave = 0): Part {
  if (s < 0 || s > 1) return "empty";
  const bend = wave * Math.sin(s * Math.PI * 2) * (0.04 + 0.06 * s);
  const y = n - bend;
  const hw = sharkHalf(s);
  const ay = Math.abs(y);

  // dorsal fin — tall triangle, reads at 10px cells
  if (s > 0.28 && s < 0.5 && y > hw * 0.45) {
    const tip = hw + 0.28 * (1 - Math.abs((s - 0.38) / 0.1));
    if (y < tip) return ay > tip - 0.04 ? "edge" : "fin";
  }
  // pectoral
  if (s > 0.16 && s < 0.48 && y < -hw * 0.35) {
    const reach = -hw - 0.16 * smoothstep(0.16, 0.38, s);
    if (y > reach) return y < reach + 0.045 ? "edge" : "fin";
  }
  // caudal fork
  if (s > 0.84) {
    const k = (s - 0.84) / 0.16;
    const fork = 0.14 * Math.sin(k * Math.PI);
    if (ay < fork + 0.025) return ay > fork - 0.02 ? "edge" : "fin";
  }
  if (ay > hw) return "empty";
  if (ay > hw - 0.04) return "edge";
  // eye
  if (s > 0.07 && s < 0.13 && y > 0.015 && y < hw * 0.75) return "eye";
  return "body";
}

/** Mid prey fish, snout at s=0 — clearer oval + dorsal + V-tail. */
export function samplePrey(s: number, n: number): Part {
  if (s < 0 || s > 1) return "empty";
  const hw =
    s < 0.12 ? 0.32 * (s / 0.12) : s > 0.72 ? 0.32 * Math.max(0, 1 - (s - 0.72) / 0.28) : 0.32;
  const ay = Math.abs(n);
  // small dorsal nub
  if (s > 0.35 && s < 0.52 && n > hw * 0.5) {
    const tip = hw + 0.14 * (1 - Math.abs((s - 0.43) / 0.085));
    if (n < tip) return n > tip - 0.04 ? "edge" : "fin";
  }
  if (ay > hw) return "empty";
  if (ay > hw - 0.07) return "edge";
  if (s > 0.1 && s < 0.2 && n > 0.02) return "eye";
  if (s > 0.78) return "fin";
  return "body";
}

/**
 * Nemo / reef / minnow scale — tiny oval + eye + V-tail.
 * Used for ambient school stamps (lighter than 3D Gaussians).
 */
export function sampleReef(s: number, n: number): Part {
  if (s < 0 || s > 1) return "empty";
  const hw = s < 0.18 ? 0.38 * (s / 0.18) : s > 0.7 ? 0.38 * (1 - (s - 0.7) / 0.3) : 0.38;
  const ay = Math.abs(n);
  if (s > 0.78) {
    const k = (s - 0.78) / 0.22;
    const fork = 0.22 * (1 - k);
    if (ay < fork) return ay > fork - 0.06 ? "edge" : "fin";
    return "empty";
  }
  if (ay > hw) return "empty";
  if (ay > hw - 0.1) return "edge";
  if (s > 0.14 && s < 0.28 && n > 0) return "eye";
  return "body";
}

/** Map a world point into local (s,n) for a creature facing `heading` radians (0 = right). */
export function toLocal(
  px: number,
  py: number,
  cx: number,
  cy: number,
  length: number,
  heading: number,
): { s: number; n: number } {
  const dx = px - cx;
  const dy = py - cy;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const along = dx * c + dy * s;
  const across = -dx * s + dy * c;
  return { s: along / length + 0.5, n: (2 * across) / length };
}
