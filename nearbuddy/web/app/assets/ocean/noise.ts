// Value noise + curl-ish drift for the mosaic field. No deps.

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1). */
export function valueNoise2(x: number, y: number, seed = 1): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

/** Multi-octave noise. */
export function fbm(x: number, y: number, octaves = 4, seed = 1): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 97);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/**
 * Drifting ribbon field: several fbm layers move at different rates.
 * Returns density in ~[0,1].
 */
export function ribbonDensity(x: number, y: number, t: number): number {
  const u = x * 0.045;
  const v = y * 0.045;
  const a = fbm(u + t * 0.12, v - t * 0.08, 4, 3);
  const b = fbm(u * 1.7 - t * 0.09, v * 1.7 + t * 0.11, 3, 11);
  const c = fbm(u * 0.55 + t * 0.04, v * 0.55 - t * 0.05, 2, 29);
  // ridge-like ribbons
  const ridge = 1 - Math.abs(a * 2 - 1);
  return Math.min(1, Math.max(0, ridge * 0.55 + b * 0.28 + c * 0.22));
}
