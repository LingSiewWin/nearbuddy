// Decorative ambient ecosystem for the hero ocean. Not board models — no fake LIVE bets.
// Tiny school uses 2D silhouette stamps; mid/large/apex are few and dramatic.
import type { CreatureBody } from "./arena-types";
import type { TierId } from "./tiers";

/**
 * Population caps (homepage FPS budget).
 * Full motion: ~32 tiny + ≤4 mid + ≤1 large + ≤1 apex (apex rarely on screen).
 * prefers-reduced-motion: ~10 tiny + ≤1 mid; no roaming apex.
 */
export const FAUNA_CAPS = {
  /** Always-on reef school (clustered into ~3 flocks). */
  tiny: 40,
  mid: 5,
  large: 1,
  apex: 1,
} as const;

export const FAUNA_CAPS_CALM = {
  tiny: 14,
  mid: 2,
  large: 0,
  apex: 0,
} as const;

export type FaunaBand = keyof typeof FAUNA_CAPS;

export type AmbientCreature = {
  id: string;
  band: FaunaBand;
  /** Visual species only; not a live model claim. */
  tier: TierId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  swimPhase: number;
  /** Stamp length in CSS px (tiny ≈ Nemo scale). */
  length: number;
  depth: number;
  accentPalette: 0 | 1 | 2;
  /** Seconds left on screen; Infinity = permanent school member. */
  life: number;
  /** True for all ambient actors — never hit-tested as duel models. */
  decorative: true;
};

const TINY_TIERS: TierId[] = ["shrimp", "crab", "fish"];
const MID_TIERS: TierId[] = ["fish", "dolphin"];

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function bandLength(band: FaunaBand, seed: number): number {
  switch (band) {
    case "tiny":
      // ~4–6 cells at CELL_SIZE 10 — Nemo-scale but still readable as fish
      return 38 + hash(seed) * 22;
    case "mid":
      return 90 + hash(seed) * 55;
    case "large":
      return 240 + hash(seed) * 90;
    case "apex":
      return 400 + hash(seed) * 70;
  }
}

function bandTier(band: FaunaBand, seed: number): TierId {
  if (band === "tiny") return TINY_TIERS[Math.floor(hash(seed) * TINY_TIERS.length)]!;
  if (band === "mid") return MID_TIERS[Math.floor(hash(seed) * MID_TIERS.length)]!;
  if (band === "large") return "shark";
  return "megalodon";
}

function bandDepth(band: FaunaBand): number {
  if (band === "tiny") return 0.72;
  if (band === "mid") return 0.82;
  if (band === "large") return 0.94;
  return 1;
}

export class AmbientFauna {
  actors: AmbientCreature[] = [];
  width = 1280;
  height = 720;
  private nextId = 1;
  private largeCooldown = 3;
  private apexCooldown = 18;
  private calm = false;

  constructor(width = 1280, height = 720) {
    this.width = width;
    this.height = height;
  }

  /** Total movers currently on screen (for tests / HUD). */
  get count(): number {
    return this.actors.length;
  }

  countsByBand(): Record<FaunaBand, number> {
    const out: Record<FaunaBand, number> = { tiny: 0, mid: 0, large: 0, apex: 0 };
    for (const a of this.actors) out[a.band] += 1;
    return out;
  }

  caps(): typeof FAUNA_CAPS | typeof FAUNA_CAPS_CALM {
    return this.calm ? FAUNA_CAPS_CALM : FAUNA_CAPS;
  }

  resize(width: number, height: number): void {
    if (width < 80 || height < 80) return;
    const sx = this.width > 0 ? width / this.width : 1;
    const sy = this.height > 0 ? height / this.height : 1;
    this.width = width;
    this.height = height;
    for (const a of this.actors) {
      a.x *= sx;
      a.y *= sy;
    }
  }

  /** Seed permanent school; call once after first real size, or when empty. */
  ensureSchool(calm = false): void {
    this.calm = calm;
    const caps = this.caps();
    const have = this.countsByBand();
    for (let i = have.tiny; i < caps.tiny; i++) this.spawn("tiny", true);
    for (let i = have.mid; i < caps.mid; i++) this.spawn("mid", true);
    // Trim if switching to calm
    this.trimToCaps();
  }

  private trimToCaps(): void {
    const caps = this.caps();
    const by: Record<FaunaBand, AmbientCreature[]> = { tiny: [], mid: [], large: [], apex: [] };
    for (const a of this.actors) by[a.band].push(a);
    const keep: AmbientCreature[] = [];
    for (const band of ["tiny", "mid", "large", "apex"] as FaunaBand[]) {
      keep.push(...by[band].slice(0, caps[band]));
    }
    this.actors = keep;
  }

  /** Public spawn for tests / preview (respects caps unless `force`). */
  spawnRoamer(band: Exclude<FaunaBand, "tiny">, force = false): AmbientCreature | null {
    if (force) this.calm = false;
    return this.spawn(band, false, force);
  }

  private spawn(band: FaunaBand, permanent: boolean, force = false): AmbientCreature | null {
    const caps = force ? FAUNA_CAPS : this.caps();
    if (this.countsByBand()[band] >= caps[band]) return null;
    const id = this.nextId++;
    const seed = id * 17.3;
    const fromLeft = hash(seed + 1) > 0.5;
    const speed =
      band === "tiny"
        ? 32 + hash(seed + 3) * 40
        : band === "mid"
          ? 44 + hash(seed + 3) * 42
          : band === "large"
            ? 75 + hash(seed + 3) * 55
            : 58 + hash(seed + 3) * 38;

    // Tiny school: pack into 3 flock centres so the hero reads as a swarm, not dust.
    let x: number;
    let y: number;
    let vx: number;
    let vy: number;
    if (band === "tiny" && permanent) {
      // Keep flocks in the open arena (right of hero copy), packed tight.
      const flock = Math.floor(hash(seed + 4) * 3); // 0..2
      const cx = this.width * (0.42 + flock * 0.2);
      const cy = this.height * (0.22 + (flock % 2) * 0.18 + hash(seed + flock * 3) * 0.2);
      const ang = hash(seed + 5) * Math.PI * 2;
      const rad = 8 + hash(seed + 6) * 42;
      x = cx + Math.cos(ang) * rad;
      y = cy + Math.sin(ang) * rad * 0.5;
      const dir = flock % 2 === 0 ? 1 : -1;
      vx = dir * speed;
      vy = (hash(seed + 7) - 0.5) * 12;
    } else if (permanent) {
      x = this.width * (0.12 + hash(seed + 4) * 0.76);
      y = this.height * (0.2 + hash(seed + 2) * 0.5);
      vx = hash(seed + 5) > 0.5 ? speed : -speed;
      vy = (hash(seed + 6) - 0.5) * 14;
    } else {
      x = fromLeft ? -bandLength(band, seed) : this.width + bandLength(band, seed);
      y = this.height * (0.2 + hash(seed + 2) * 0.48);
      vx = fromLeft ? speed : -speed;
      vy = (hash(seed + 6) - 0.5) * 12;
    }

    const actor: AmbientCreature = {
      id: `fauna:${id}`,
      band,
      tier: bandTier(band, seed),
      x,
      y,
      vx,
      vy,
      swimPhase: hash(seed + 8) * Math.PI * 2,
      length: bandLength(band, seed),
      depth: bandDepth(band),
      accentPalette: (Math.floor(hash(seed + 9) * 3) % 3) as 0 | 1 | 2,
      life: permanent
        ? Infinity
        : band === "apex"
          ? 9 + hash(seed + 10) * 4
          : band === "large"
            ? 7 + hash(seed + 10) * 3
            : 12,
      decorative: true,
    };
    this.actors.push(actor);
    return actor;
  }

  /**
   * Step school (Reynolds-ish) + periodic large/apex entrances.
   * Pass duel bodies so the school parts around heroes.
   * `dt === 0` → calm / reduced motion (no new apex, soft drift).
   */
  step(dt: number, timeSec: number, duelists: readonly CreatureBody[] = []): void {
    const calm = dt <= 0;
    if (calm !== this.calm || this.actors.length === 0) this.ensureSchool(calm);

    if (!calm) {
      this.largeCooldown -= dt;
      this.apexCooldown -= dt;
      if (this.largeCooldown <= 0 && this.countsByBand().large < this.caps().large) {
        this.spawn("large", false);
        this.largeCooldown = 10 + Math.random() * 8;
      }
      if (this.apexCooldown <= 0 && this.countsByBand().apex < this.caps().apex) {
        this.spawn("apex", false);
        this.apexCooldown = 40 + Math.random() * 35;
      }
    }

    const margin = 40;
    const bottomReserve = 140;

    for (let i = this.actors.length - 1; i >= 0; i--) {
      const a = this.actors[i]!;
      if (Number.isFinite(a.life)) {
        a.life -= calm ? 0 : dt;
        if (a.life <= 0) {
          this.actors.splice(i, 1);
          continue;
        }
      }

      let sx = 0;
      let sy = 0;
      let ax = 0;
      let ay = 0;
      let cx = 0;
      let cy = 0;
      let neighbors = 0;

      if (a.band === "tiny") {
        for (let j = 0; j < this.actors.length; j++) {
          const o = this.actors[j]!;
          if (o.band !== "tiny" || o.id === a.id) continue;
          const dx = o.x - a.x;
          const dy = o.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 95 * 95 || d2 < 1e-4) continue;
          const d = Math.sqrt(d2);
          neighbors += 1;
          if (d < 22) {
            sx -= dx / d;
            sy -= dy / d;
          }
          ax += o.vx;
          ay += o.vy;
          cx += o.x;
          cy += o.y;
        }
        if (neighbors > 0) {
          ax /= neighbors;
          ay /= neighbors;
          cx = cx / neighbors - a.x;
          cy = cy / neighbors - a.y;
        }
      }

      // Part around larger fauna + duel heroes
      for (const o of this.actors) {
        if (o.id === a.id) continue;
        if (o.band === "tiny" && a.band === "tiny") continue;
        const dx = o.x - a.x;
        const dy = o.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const fearR = o.band === "apex" ? 280 : o.band === "large" ? 200 : 90;
        if (dist < fearR && tierRank(o.band) > tierRank(a.band)) {
          sx -= (dx / dist) * 2.2;
          sy -= (dy / dist) * 2.2;
        }
      }
      for (const d of duelists) {
        const dx = d.x - a.x;
        const dy = d.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        if (dist < 160) {
          sx -= (dx / dist) * 1.8;
          sy -= (dy / dist) * 1.8;
        }
      }

      // Soft wander
      sx += Math.cos(timeSec * 0.55 + a.swimPhase) * 0.35;
      sy += Math.sin(timeSec * 0.42 + a.swimPhase * 1.3) * 0.3;
      sx += ax * 0.04 + cx * 0.008;
      sy += ay * 0.04 + cy * 0.008;

      if (calm) {
        a.x += Math.cos(timeSec * 0.2 + a.swimPhase) * 0.15;
        a.y += Math.sin(timeSec * 0.18 + a.swimPhase) * 0.12;
        a.swimPhase += 0.02;
        continue;
      }

      a.vx += sx * 55 * dt;
      a.vy += sy * 55 * dt;

      if (a.x < margin) a.vx += 80 * dt;
      if (a.x > this.width - margin) a.vx -= 80 * dt;
      if (a.y < margin) a.vy += 90 * dt;
      if (a.y > this.height - bottomReserve) a.vy -= 100 * dt;

      const maxSp = a.band === "tiny" ? 70 : a.band === "mid" ? 95 : a.band === "large" ? 130 : 110;
      const sp = Math.hypot(a.vx, a.vy) || 1;
      if (sp > maxSp) {
        a.vx = (a.vx / sp) * maxSp;
        a.vy = (a.vy / sp) * maxSp;
      } else if (sp < 22) {
        a.vx = (a.vx / sp) * 22;
        a.vy = (a.vy / sp) * 22;
      }

      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.swimPhase += dt * (3.8 + (sp / maxSp) * 3.2);

      // Transient roamers exit off-screen
      if (Number.isFinite(a.life) && (a.x < -a.length * 1.5 || a.x > this.width + a.length * 1.5)) {
        this.actors.splice(i, 1);
      }
    }
  }
}

function tierRank(band: FaunaBand): number {
  if (band === "tiny") return 0;
  if (band === "mid") return 1;
  if (band === "large") return 2;
  return 3;
}

/** Force an apex entrance (preview / tests). */
export function forceApexEntrance(fauna: AmbientFauna): AmbientCreature | null {
  return fauna.spawnRoamer("apex", true);
}
