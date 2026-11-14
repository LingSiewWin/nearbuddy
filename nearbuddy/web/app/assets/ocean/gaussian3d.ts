// 3D Gaussian splat → ASCII grid. Ported from the founder Step-1 gaussian3d paste;
// tiers map to NearBuddy TierId (shrimp…megalodon). Pure engine — no React.
// Ambient fauna (school / roamers) stamp as 2D silhouettes for FPS; duelists stay Gaussian.
import type { CreatureBody, PredationRipple } from "./arena-types";
import type { AmbientCreature } from "./fauna";
import { type Part, samplePrey, sampleShark } from "./shapes";
import type { TierId } from "./tiers";

export const CELL_SIZE = 10;
export const ASCII_RAMP = [" ", ".", ":", "-", "o", "t", "S", "%", "X", "8", "@"] as const;

type SpeciesParams = {
  length: number;
  maxRad: number;
  rings: number;
  ringSamples: number;
  hammerhead: boolean;
  bigFins: boolean;
  skipBodyFins: boolean;
  tailAmp: number;
};

/** Size / silhouette params per NearBuddy tier (~220–380 Gaussians on shark+). Hero-scaled so duelists read at a glance. */
function speciesParams(tier: TierId): SpeciesParams {
  switch (tier) {
    case "shrimp":
      return {
        length: 96,
        maxRad: 16,
        rings: 9,
        ringSamples: 5,
        hammerhead: false,
        bigFins: false,
        skipBodyFins: true,
        tailAmp: 9,
      };
    case "crab":
      return {
        length: 140,
        maxRad: 22,
        rings: 12,
        ringSamples: 7,
        hammerhead: false,
        bigFins: false,
        skipBodyFins: true,
        tailAmp: 12,
      };
    case "fish":
      return {
        length: 200,
        maxRad: 28,
        rings: 16,
        ringSamples: 8,
        hammerhead: false,
        bigFins: false,
        skipBodyFins: false,
        tailAmp: 18,
      };
    case "dolphin":
      return {
        length: 270,
        maxRad: 36,
        rings: 20,
        ringSamples: 9,
        hammerhead: false,
        bigFins: true,
        skipBodyFins: false,
        tailAmp: 26,
      };
    case "shark":
      return {
        length: 360,
        maxRad: 48,
        rings: 24,
        ringSamples: 9,
        hammerhead: true,
        bigFins: true,
        skipBodyFins: false,
        tailAmp: 34,
      };
    case "megalodon":
      return {
        length: 520,
        maxRad: 74,
        rings: 28,
        ringSamples: 10,
        hammerhead: false,
        bigFins: true,
        skipBodyFins: false,
        tailAmp: 48,
      };
  }
}

function partBoost(part: Part): number {
  if (part === "empty") return 0;
  if (part === "eye") return 1;
  if (part === "edge") return 0.94;
  if (part === "fin") return 0.8;
  return 1;
}

/**
 * Hard-edged Nemo-scale bitmaps (facing right). Flipped when swimming left.
 * Compact fish / shrimp profiles that stay readable on the 10px ASCII grid.
 */
const TINY_FISH: readonly (readonly number[])[] = [
  [0, 0, 1, 1, 0, 0],
  [1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 0, 1],
];
const TINY_SHRIMP: readonly (readonly number[])[] = [
  [0, 1, 1, 1, 0],
  [1, 1, 1, 0, 1],
];

function stampTinyBitmap(buffers: GridBuffers, actor: AmbientCreature): void {
  const { cols, rows, density, shade, zBuffer, glint, palette } = buffers;
  const facingRight = actor.vx >= 0;
  const pattern = actor.tier === "shrimp" ? TINY_SHRIMP : TINY_FISH;
  const ph = pattern.length;
  const pw = pattern[0]!.length;
  const originCol = Math.floor(actor.x / CELL_SIZE) - Math.floor(pw / 2);
  const originRow = Math.floor(actor.y / CELL_SIZE) - Math.floor(ph / 2);
  // Closer than plankton so school wins z-buffer; still behind duelists (~380)
  const gz = 500;
  for (let r = 0; r < ph; r++) {
    for (let c = 0; c < pw; c++) {
      const bit = facingRight ? pattern[r]![c]! : pattern[r]![pw - 1 - c]!;
      if (!bit) continue;
      const col = originCol + c;
      const row = originRow + r;
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const idx = row * cols + col;
      const boost = Math.min(1, actor.depth * (r === 1 ? 1.05 : 0.92));
      if (gz < zBuffer[idx]!) zBuffer[idx] = gz;
      if (boost >= density[idx]!) {
        density[idx] = boost;
        shade[idx] = 0.95;
        palette[idx] = actor.accentPalette;
        glint[idx] = Math.max(glint[idx]!, 0.85);
      }
    }
  }
}

/** Lightweight 2D stamp for ambient fauna — keeps swarm FPS cheap vs full Gaussians. */
function stampAmbient(buffers: GridBuffers, actor: AmbientCreature): void {
  if (actor.band === "tiny") {
    stampTinyBitmap(buffers, actor);
    return;
  }

  const { cols, rows, density, shade, zBuffer, glint, palette } = buffers;
  const heading = Math.atan2(actor.vy, actor.vx);
  const wave = Math.sin(actor.swimPhase) * (actor.band === "mid" ? 0.3 : 0.5);
  const len = Math.max(40, actor.length);
  const halfW = len * 0.55;
  const halfH = len * 0.42;
  const c0 = Math.max(0, Math.floor((actor.x - halfW) / CELL_SIZE));
  const c1 = Math.min(cols - 1, Math.ceil((actor.x + halfW) / CELL_SIZE));
  const r0 = Math.max(0, Math.floor((actor.y - halfH) / CELL_SIZE));
  const r1 = Math.min(rows - 1, Math.ceil((actor.y + halfH) / CELL_SIZE));
  // Apex/large slightly in front of mid; mid behind duelists (~380)
  const gz = actor.band === "apex" ? 300 : actor.band === "large" ? 340 : 500;
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);

  for (let row = r0; row <= r1; row++) {
    const py = (row + 0.5) * CELL_SIZE;
    for (let col = c0; col <= c1; col++) {
      const px = (col + 0.5) * CELL_SIZE;
      const dx = px - actor.x;
      const dy = py - actor.y;
      const along = dx * cosH + dy * sinH;
      const across = -dx * sinH + dy * cosH;
      const s = along / len + 0.5;
      const n = (2 * across) / len;
      const part: Part = actor.band === "mid" ? samplePrey(s, n) : sampleShark(s, n, wave);
      const boost = partBoost(part) * actor.depth;
      if (boost < 0.05) continue;
      const idx = row * cols + col;
      if (gz > zBuffer[idx]! + 10 && density[idx]! > boost * 0.9) continue;
      if (gz < zBuffer[idx]!) zBuffer[idx] = gz;
      if (boost >= density[idx]!) {
        density[idx] = Math.min(1, boost);
        shade[idx] = part === "eye" ? 1 : part === "edge" ? 0.95 : 0.78 + actor.depth * 0.15;
        palette[idx] = actor.accentPalette;
        if (part === "eye" || part === "edge") glint[idx] = Math.max(glint[idx]!, part === "eye" ? 1 : 0.65);
      }
    }
  }
}

type GaussianPrimitive = {
  s: number;
  lat: number;
  vert: number;
  rx: number;
  ry: number;
  nx: number;
  ny: number;
  nz: number;
  alpha: number;
  isGlintTip: boolean;
  scatterX: number;
  scatterY: number;
  scatterZ: number;
};

const speciesCache = new Map<TierId, GaussianPrimitive[]>();

function hash1(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function getSpeciesGaussians(tier: TierId): GaussianPrimitive[] {
  const cached = speciesCache.get(tier);
  if (cached) return cached;

  const p = speciesParams(tier);
  const list: GaussianPrimitive[] = [];
  let seed = tier.length * 97;

  const pushGaussian = (
    s: number,
    lat: number,
    vert: number,
    rx: number,
    ry: number,
    nx: number,
    ny: number,
    nz: number,
    alpha: number,
    isGlintTip = false,
  ) => {
    seed += 1;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    list.push({
      s,
      lat,
      vert,
      rx,
      ry,
      nx: nx / nLen,
      ny: ny / nLen,
      nz: nz / nLen,
      alpha,
      isGlintTip,
      scatterX: (hash1(seed * 1.3) - 0.5) * 2.4,
      scatterY: (hash1(seed * 2.7) - 0.5) * 2.4,
      scatterZ: (hash1(seed * 4.1) - 0.5) * 2.4,
    });
  };

  const { length, maxRad, rings, ringSamples, hammerhead: isHammerhead, bigFins: hasBigFins } = p;

  // 1. Fusiform body rings
  for (let i = 0; i <= rings; i++) {
    const s = i / rings;
    let profile: number;
    if (s < 0.24) profile = Math.sin((s / 0.24) * (Math.PI * 0.5)) ** 0.72;
    else if (s < 0.84) profile = 1 - 0.84 * ((s - 0.24) / 0.6) ** 1.15;
    else profile = 0.16;

    const rLat = maxRad * profile * (isHammerhead && s < 0.12 ? 1.25 : 0.92);
    const rVert = maxRad * profile * 1.06;
    const splatSize = Math.max(4.5, (length / rings) * 0.85);

    for (let j = 0; j < ringSamples; j++) {
      const theta = (j / ringSamples) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      pushGaussian(
        s,
        cosT * rLat,
        sinT * rVert,
        splatSize,
        splatSize * 0.88,
        -0.25,
        sinT,
        cosT,
        sinT < 0 ? 0.92 : 0.78,
        i === 0 && j % 3 === 0,
      );
    }
  }

  // 2. Hammerhead cephalofoil (shark tier)
  if (isHammerhead) {
    for (const side of [-1, 1] as const) {
      for (let k = 1; k <= 5; k++) {
        const t = k / 5;
        pushGaussian(
          0.06 + t * 0.03,
          side * (maxRad * 0.7 + t * maxRad * 1.45),
          -maxRad * 0.08,
          8,
          6,
          0.2,
          -0.8,
          side * 0.5,
          0.95,
          k === 5,
        );
      }
    }
  }

  // 3. Dorsal fin
  if (!p.skipBodyFins) {
    const finSteps = hasBigFins ? 6 : 3;
    for (let k = 1; k <= finSteps; k++) {
      const t = k / finSteps;
      pushGaussian(
        0.34 + t * 0.14,
        0,
        -maxRad * (0.85 + t * (hasBigFins ? 1.15 : 0.65)),
        Math.max(5, 11 * (1 - t * 0.55)),
        Math.max(5, 10 * (1 - t * 0.5)),
        -0.2,
        -0.85,
        0.35,
        0.9,
        k === finSteps,
      );
    }
  }

  // 4. Pectoral fins
  if (!p.skipBodyFins) {
    const wingSteps = hasBigFins ? 6 : 3;
    for (const side of [-1, 1] as const) {
      for (let k = 1; k <= wingSteps; k++) {
        const t = k / wingSteps;
        pushGaussian(
          0.28 + t * 0.14,
          side * maxRad * (0.75 + t * (hasBigFins ? 1.55 : 0.85)),
          maxRad * (0.25 + t * 0.35),
          Math.max(5, 11 * (1 - t * 0.5)),
          Math.max(4, 7 * (1 - t * 0.5)),
          0,
          -0.75,
          side * 0.65,
          0.88,
          k === wingSteps,
        );
      }
    }
  }

  // 5. Forked caudal
  const tailSteps = hasBigFins ? 6 : 4;
  for (let k = 1; k <= tailSteps; k++) {
    const t = k / tailSteps;
    const s = 0.84 + t * 0.16;
    pushGaussian(
      s,
      0,
      -maxRad * (0.15 + t * 1.15),
      Math.max(4.5, 9 * (1 - t * 0.45)),
      Math.max(4.5, 8 * (1 - t * 0.45)),
      -0.3,
      -0.6,
      0.4,
      0.92,
      k === tailSteps,
    );
    pushGaussian(
      s - 0.02,
      0,
      maxRad * (0.12 + t * 0.78),
      Math.max(4, 8 * (1 - t * 0.5)),
      Math.max(4, 7 * (1 - t * 0.5)),
      -0.3,
      0.6,
      0.4,
      0.85,
      k === tailSteps,
    );
  }

  speciesCache.set(tier, list);
  return list;
}

/** Gaussian count for a tier (for tests / budget checks). */
export function gaussianCount(tier: TierId): number {
  return getSpeciesGaussians(tier).length;
}

export type GridBuffers = {
  cols: number;
  rows: number;
  density: Float32Array;
  shade: Float32Array;
  zBuffer: Float32Array;
  glint: Float32Array;
  palette: Uint8Array;
};

export function allocBuffers(cols: number, rows: number): GridBuffers {
  const total = Math.max(1, cols * rows);
  return {
    cols,
    rows,
    density: new Float32Array(total),
    shade: new Float32Array(total),
    zBuffer: new Float32Array(total),
    glint: new Float32Array(total),
    palette: new Uint8Array(total),
  };
}

/** Project 3D Gaussian clouds onto the ASCII grid with z-buffer + Lambertian shade. */
export function rasterizeOceanField(
  buffers: GridBuffers,
  creatures: CreatureBody[],
  ripples: PredationRipple[],
  timeSec: number,
  viewportWidth: number,
  viewportHeight: number,
  fauna: readonly AmbientCreature[] = [],
): void {
  const { cols, rows, density, shade, zBuffer, glint, palette } = buffers;
  density.fill(0);
  shade.fill(0.5);
  zBuffer.fill(Infinity);
  glint.fill(0);

  const cx = viewportWidth * 0.5;
  const cy = viewportHeight * 0.5;
  // Closer camera + longer focal so hero duelists read as solid volumes, not dust.
  const focalLength = 820;
  const lx = -0.32;
  const ly = -0.84;
  const lz = -0.43;

  // Ambient plankton (sparse — school carries the ecosystem feel)
  for (let i = 0; i < 40; i++) {
    const px = (hash1(i * 13.1) - 0.5) * viewportWidth * 1.15 + Math.sin(timeSec * 0.3 + i) * 28;
    const py = (hash1(i * 29.7) - 0.5) * viewportHeight * 1.15 + Math.cos(timeSec * 0.25 + i) * 22;
    const pz = 420 + hash1(i * 53.3) * 520;
    const scale = focalLength / pz;
    const sx = cx + px * scale;
    const sy = cy + py * scale;
    const col = Math.floor(sx / CELL_SIZE);
    const row = Math.floor(sy / CELL_SIZE);
    if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
    const idx = row * cols + col;
    if (pz < zBuffer[idx]!) {
      zBuffer[idx] = pz;
      density[idx] = 0.14 + (i % 4) * 0.05;
      shade[idx] = 0.72;
      palette[idx] = (i % 3) as 0 | 1 | 2;
      if (i % 9 === 0) glint[idx] = 0.85;
    }
  }

  // Decorative school / roamers (2D stamps). Draw before duelists so Gaussian heroes win z-ties.
  for (const actor of fauna) stampAmbient(buffers, actor);

  for (let cIdx = 0; cIdx < creatures.length; cIdx++) {
    const c = creatures[cIdx]!;
    const gaussians = getSpeciesGaussians(c.tier);
    const params = speciesParams(c.tier);

    const wx0 = c.x - cx;
    const wy0 = c.y - cy;
    const wz0 = 380 + Math.sin(timeSec * 0.45 + cIdx * 2.2) * 90;

    const vz = Math.cos(timeSec * 0.45 + cIdx * 2.2) * 42;
    const vLen = Math.hypot(c.vx, c.vy, vz) || 1;
    const fx = c.vx / vLen;
    const fy = c.vy / vLen;
    const fz = vz / vLen;

    let ux = 0;
    let uy = -1;
    let uz = 0;

    let rx = uy * fz - uz * fy;
    let ry = uz * fx - ux * fz;
    let rz = ux * fy - uy * fx;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;

    ux = fy * rz - fz * ry;
    uy = fz * rx - fx * rz;
    uz = fx * ry - fy * rx;

    const bankAngle = Math.max(-0.55, Math.min(0.55, (c.vy / 140) * (fx >= 0 ? 0.5 : -0.5)));
    const cosB = Math.cos(bankAngle);
    const sinB = Math.sin(bankAngle);
    const rbx = rx * cosB + ux * sinB;
    const rby = ry * cosB + uy * sinB;
    const rbz = rz * cosB + uz * sinB;
    const ubx = ux * cosB - rx * sinB;
    const uby = uy * cosB - ry * sinB;
    const ubz = uz * cosB - rz * sinB;

    const spineLen = params.length;
    const tailAmp = params.tailAmp;
    const dispersion = c.fooledTimer > 0 ? Math.min(1, c.fooledTimer / 1.2) : 0;

    for (let gIdx = 0; gIdx < gaussians.length; gIdx++) {
      const g = gaussians[gIdx]!;
      const swimWave = Math.sin(c.swimPhase - g.s * 6.4) * tailAmp * g.s ** 1.45;
      const localFwd = -g.s * spineLen + g.scatterX * dispersion * 65;
      const localLat = g.lat + swimWave + g.scatterZ * dispersion * 75;
      const localVert = g.vert + g.scatterY * dispersion * 65;

      const gx = wx0 + fx * localFwd + rbx * localLat + ubx * localVert;
      const gy = wy0 + fy * localFwd + rby * localLat + uby * localVert;
      const gz = wz0 + fz * localFwd + rbz * localLat + ubz * localVert;
      if (gz < 160) continue;

      const proj = focalLength / gz;
      const sx = cx + gx * proj;
      const sy = cy + gy * proj;
      const radScale = 1.35 + dispersion * 0.75;
      const splatRx = Math.max(CELL_SIZE * 0.85, g.rx * proj * radScale);
      const splatRy = Math.max(CELL_SIZE * 0.85, g.ry * proj * radScale);

      const wnx = fx * g.nx + rbx * g.ny + ubx * g.nz;
      const wny = fy * g.nx + rby * g.ny + uby * g.nz;
      const wnz = fz * g.nx + rbz * g.ny + ubz * g.nz;
      const ndotl = Math.max(0, wnx * lx + wny * ly + wnz * lz);
      const depthAtten = Math.max(0.45, Math.min(1.05, 1.18 - (gz - 350) / 850));
      const lit = (0.28 + 0.72 * ndotl) * depthAtten;

      const c0 = Math.max(0, Math.floor((sx - splatRx * 1.4) / CELL_SIZE));
      const c1 = Math.min(cols - 1, Math.ceil((sx + splatRx * 1.4) / CELL_SIZE));
      const r0 = Math.max(0, Math.floor((sy - splatRy * 1.4) / CELL_SIZE));
      const r1 = Math.min(rows - 1, Math.ceil((sy + splatRy * 1.4) / CELL_SIZE));
      const invRxSq = 1 / (splatRx * splatRx);
      const invRySq = 1 / (splatRy * splatRy);

      for (let row = r0; row <= r1; row++) {
        const py = (row + 0.5) * CELL_SIZE - sy;
        const pySq = py * py * invRySq;
        if (pySq > 2.0) continue;
        for (let col = c0; col <= c1; col++) {
          const px = (col + 0.5) * CELL_SIZE - sx;
          const distSq = px * px * invRxSq + pySq;
          if (distSq > 2.0) continue;
          const weight = Math.exp(-1.0 * distSq) * g.alpha * 1.25 * (1 - dispersion * 0.35);
          if (weight < 0.035) continue;
          const idx = row * cols + col;
          if (gz <= zBuffer[idx]! + 18) {
            if (gz < zBuffer[idx]!) zBuffer[idx] = gz;
            const combined = Math.min(1, density[idx]! * 0.35 + weight);
            if (combined >= density[idx]!) {
              density[idx] = combined;
              shade[idx] = lit;
              palette[idx] = c.accentPalette;
              if (g.isGlintTip || (weight > 0.25 && weight < 0.52)) {
                glint[idx] = Math.max(glint[idx]!, g.isGlintTip ? 0.95 : 0.45);
              }
            }
          }
        }
      }
    }
  }

  for (const ripple of ripples) {
    const bandWidth = CELL_SIZE * 1.6;
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
        if (d > density[idx]!) {
          density[idx] = d;
          shade[idx] = 0.88;
          palette[idx] = ripple.accentPalette;
          glint[idx] = Math.max(glint[idx]!, ripple.alpha);
        }
      }
    }
  }
}
