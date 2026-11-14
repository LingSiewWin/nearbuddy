// Procedural 2D SDF spine creatures → discrete ASCII grid buffers.
// Ported from the Step 1 engine blueprint; tiers map to NearBuddy TierId.
import type { CreatureBody, PredationRipple } from "./arena-types";
import type { TierId } from "./tiers";

export const CELL_SIZE = 12;
export const ASCII_RAMP = [" ", ".", ":", "-", "o", "t", "S", "%", "X", "8", "@"] as const;

type SpineSpec = {
  length: number;
  maxRadius: number;
  tailAmplitude: number;
  waveFrequency: number;
  hasDorsalFin: boolean;
  coreBoost: number;
};

function getSpineSpec(creature: CreatureBody): SpineSpec {
  const m = Math.max(0.45, Math.min(3.2, creature.multiplier));
  const tier: TierId = creature.tier;
  switch (tier) {
    case "shrimp":
      return {
        length: 44 + m * 16,
        maxRadius: 9 + m * 3,
        tailAmplitude: 6,
        waveFrequency: 5.5,
        hasDorsalFin: false,
        coreBoost: 0.72,
      };
    case "crab":
      return {
        length: 70 + m * 28,
        maxRadius: 12 + m * 4,
        tailAmplitude: 9,
        waveFrequency: 5.8,
        hasDorsalFin: false,
        coreBoost: 0.78,
      };
    case "fish":
      return {
        length: 110 + (m - 0.85) * 90,
        maxRadius: 15 + (m - 0.85) * 8,
        tailAmplitude: 13,
        waveFrequency: 6.2,
        hasDorsalFin: false,
        coreBoost: 0.84,
      };
    case "dolphin":
      return {
        length: 160 + (m - 1.0) * 100,
        maxRadius: 20 + (m - 1.0) * 9,
        tailAmplitude: 18,
        waveFrequency: 6.5,
        hasDorsalFin: true,
        coreBoost: 0.9,
      };
    case "shark":
      return {
        length: 210 + (m - 1.25) * 110,
        maxRadius: 24 + (m - 1.25) * 10,
        tailAmplitude: 22,
        waveFrequency: 6.8,
        hasDorsalFin: true,
        coreBoost: 0.94,
      };
    case "megalodon":
      return {
        length: 340 + Math.min(1.2, m - 2.0) * 120,
        maxRadius: 38 + Math.min(1.2, m - 2.0) * 14,
        tailAmplitude: 32,
        waveFrequency: 7.2,
        hasDorsalFin: true,
        coreBoost: 1.0,
      };
  }
}

function bodyRadiusAt(s: number, maxRadius: number): number {
  if (s < 0.22) return Math.sin((s / 0.22) * (Math.PI * 0.5)) ** 0.72 * maxRadius;
  if (s < 0.82) {
    const t = (s - 0.22) / 0.6;
    return maxRadius * (1 - 0.82 * t ** 1.15);
  }
  const tailT = (s - 0.82) / 0.18;
  return maxRadius * (0.18 + 0.52 * Math.sin(tailT * Math.PI * 0.85));
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { dist: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 1e-6 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  return { dist: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

export type GridBuffers = {
  cols: number;
  rows: number;
  density: Float32Array;
  glint: Float32Array;
  palette: Uint8Array;
};

export function allocBuffers(cols: number, rows: number): GridBuffers {
  const total = Math.max(1, cols * rows);
  return {
    cols,
    rows,
    density: new Float32Array(total),
    glint: new Float32Array(total),
    palette: new Uint8Array(total),
  };
}

/** Rasterize creatures + ripples into density/glint/palette grids. */
export function rasterizeOceanField(
  buffers: GridBuffers,
  creatures: CreatureBody[],
  ripples: PredationRipple[],
  timeSec: number,
): void {
  const { cols, rows, density, glint, palette } = buffers;
  density.fill(0);
  glint.fill(0);

  for (let i = 0; i < 36; i++) {
    const wx = ((Math.sin(i * 12.9898 + timeSec * 0.18) * 0.5 + 0.5) * cols) | 0;
    const wy = ((Math.cos(i * 78.233 + timeSec * 0.14) * 0.5 + 0.5) * rows) | 0;
    if (wx >= 0 && wx < cols && wy >= 0 && wy < rows) {
      const idx = wy * cols + wx;
      density[idx] = Math.max(density[idx] ?? 0, 0.12 + (i % 3) * 0.05);
    }
  }

  const SEGMENTS = 12;
  const jx = new Float32Array(SEGMENTS + 1);
  const jy = new Float32Array(SEGMENTS + 1);
  const jr = new Float32Array(SEGMENTS + 1);

  for (const creature of creatures) {
    const spec = getSpineSpec(creature);
    const speed = Math.hypot(creature.vx, creature.vy);
    const fx = speed > 1e-4 ? creature.vx / speed : 1;
    const fy = speed > 1e-4 ? creature.vy / speed : 0;
    const upSign = fx >= 0 ? -1 : 1;
    const nx = -fy * upSign;
    const ny = fx * upSign;
    const jitterScale = creature.fooledTimer > 0 ? 1.8 : 1.0;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i <= SEGMENTS; i++) {
      const s = i / SEGMENTS;
      const wave = Math.sin(creature.swimPhase - s * spec.waveFrequency) * spec.tailAmplitude * s ** 1.45 * jitterScale;
      const x = creature.x - fx * (s * spec.length) + nx * wave;
      const y = creature.y - fy * (s * spec.length) + ny * wave;
      const r = bodyRadiusAt(s, spec.maxRadius);
      jx[i] = x;
      jy[i] = y;
      jr[i] = r;
      const pad = r + CELL_SIZE * 2.5;
      if (x - pad < minX) minX = x - pad;
      if (x + pad > maxX) maxX = x + pad;
      if (y - pad < minY) minY = y - pad;
      if (y + pad > maxY) maxY = y + pad;
    }

    const dorsalBaseIdx = 4;
    const dorsalBaseX = jx[dorsalBaseIdx] ?? 0;
    const dorsalBaseY = jy[dorsalBaseIdx] ?? 0;
    const dorsalTipX = dorsalBaseX + nx * (spec.maxRadius * 1.65) - fx * (spec.maxRadius * 0.65);
    const dorsalTipY = dorsalBaseY + ny * (spec.maxRadius * 1.65) - fy * (spec.maxRadius * 0.65);

    const c0 = Math.max(0, Math.floor(minX / CELL_SIZE));
    const c1 = Math.min(cols - 1, Math.ceil(maxX / CELL_SIZE));
    const r0 = Math.max(0, Math.floor(minY / CELL_SIZE));
    const r1 = Math.min(rows - 1, Math.ceil(maxY / CELL_SIZE));
    const feather = CELL_SIZE * 1.35;

    for (let row = r0; row <= r1; row++) {
      const py = (row + 0.5) * CELL_SIZE;
      for (let col = c0; col <= c1; col++) {
        const px = (col + 0.5) * CELL_SIZE;
        let minSd = Infinity;
        for (let i = 0; i < SEGMENTS; i++) {
          const x0 = jx[i] ?? 0;
          const y0 = jy[i] ?? 0;
          const x1 = jx[i + 1] ?? 0;
          const y1 = jy[i + 1] ?? 0;
          const r0s = jr[i] ?? 0;
          const r1s = jr[i + 1] ?? 0;
          const { dist, t } = distToSegment(px, py, x0, y0, x1, y1);
          const sd = dist - (r0s + t * (r1s - r0s));
          if (sd < minSd) minSd = sd;
        }
        if (spec.hasDorsalFin) {
          const { dist, t } = distToSegment(px, py, dorsalBaseX, dorsalBaseY, dorsalTipX, dorsalTipY);
          const finSd = dist - spec.maxRadius * 0.42 * (1 - t * 0.85);
          if (finSd < minSd) minSd = finSd;
        }
        if (minSd >= feather) continue;

        let d: number;
        if (minSd <= 0) {
          const coreDepth = Math.min(1, -minSd / Math.max(6, spec.maxRadius * 0.75));
          d = (0.58 + 0.42 * coreDepth) * spec.coreBoost;
        } else {
          d = 0.58 * (1 - minSd / feather) * spec.coreBoost;
        }
        if (creature.fooledTimer > 0) {
          const hash = Math.sin(col * 17.1 + row * 31.7 + timeSec * 24) * 0.5 + 0.5;
          if (hash > 0.62) d *= 0.25;
        }
        const idx = row * cols + col;
        const prev = density[idx] ?? 0;
        if (d > prev) {
          density[idx] = d;
          palette[idx] = creature.accentPalette;
          const edgeBand = d > 0.22 && d < 0.78 ? 1 - Math.abs(d - 0.5) * 3.2 : 0;
          glint[idx] = Math.max(glint[idx] ?? 0, edgeBand * 0.85);
        }
      }
    }
  }

  for (const ripple of ripples) {
    const bandWidth = CELL_SIZE * 1.8;
    const c0 = Math.max(0, Math.floor((ripple.x - ripple.radius - bandWidth) / CELL_SIZE));
    const c1 = Math.min(cols - 1, Math.ceil((ripple.x + ripple.radius + bandWidth) / CELL_SIZE));
    const r0 = Math.max(0, Math.floor((ripple.y - ripple.radius - bandWidth) / CELL_SIZE));
    const r1 = Math.min(rows - 1, Math.ceil((ripple.y + ripple.radius + bandWidth) / CELL_SIZE));
    for (let row = r0; row <= r1; row++) {
      const py = (row + 0.5) * CELL_SIZE;
      for (let col = c0; col <= c1; col++) {
        const px = (col + 0.5) * CELL_SIZE;
        const ringDist = Math.abs(Math.hypot(px - ripple.x, py - ripple.y) - ripple.radius);
        if (ringDist >= bandWidth) continue;
        const d = (1 - ringDist / bandWidth) * ripple.alpha * 0.85;
        const idx = row * cols + col;
        const prev = density[idx] ?? 0;
        if (d > prev) {
          density[idx] = d;
          palette[idx] = ripple.accentPalette;
          glint[idx] = Math.max(glint[idx] ?? 0, ripple.alpha);
        }
      }
    }
  }
}
