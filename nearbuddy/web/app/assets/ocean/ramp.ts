/** Mosaic density ramp (low → high), architectural ASCII field. */
export const MOSAIC_RAMP = [" ", ".", ":", "-", "o", "t", "S", "%", "X", "8", "@"] as const;

export const MOSAIC = {
  bg: "#F9F9FB",
  grid: "#EAEAEF",
  cellLo: "#ECECEF",
  cellHi: "#222226",
  pitch: 13,
} as const;

/** Subtle iridescent accents for high-density edges (muted). */
export const ACCENTS = [
  [90, 140, 150], // muted teal
  [160, 130, 90], // soft amber
  [100, 120, 150], // slate blue
  [170, 110, 110], // faint coral
] as const;

export function mosaicGlyph(density: number, salt: number): string {
  const t = Math.min(1, Math.max(0, density));
  const i = Math.min(MOSAIC_RAMP.length - 1, Math.floor(t * MOSAIC_RAMP.length));
  const j = Math.min(MOSAIC_RAMP.length - 1, Math.max(0, i + ((salt % 3) - 1)));
  return MOSAIC_RAMP[j] ?? " ";
}

/** Lerp cell fill from light gray to near-black by density. */
export function cellFill(density: number): string {
  const t = Math.min(1, Math.max(0, density));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(0xec, 0x22)},${mix(0xec, 0x22)},${mix(0xef, 0x26)})`;
}

/** Glyph ink: dark on light cells, light on dark cells. */
export function cellInk(density: number): string {
  return density > 0.45 ? "#F4F4F6" : "#2A2A2E";
}

export function accentRgb(salt: number): [number, number, number] {
  const a = ACCENTS[salt % ACCENTS.length] ?? ACCENTS[0];
  return [a[0], a[1], a[2]];
}

/** Repeatable [0,1) from cell coords + time bucket. */
export function cellHash(x: number, y: number, t = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(t | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
