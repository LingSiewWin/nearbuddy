// Reynolds seek/flee + 2-slot duel sim. Board models for duelists; AmbientFauna for ecosystem fillers.
import type { CreatureBody, DecisionTick, ModelSeed, ModelSpec, PredationRipple, SimStake } from "./arena-types";
import { AmbientFauna } from "./fauna";
import { heldOf, mayEat, type Resistance, rateOf, tierOf } from "./tiers";

export type BoardModelRow = {
  model: string;
  tested: number;
  fooled: number;
  attacks?: number;
};

export function shortModelLabel(modelId: string): string {
  return modelId.split("/").pop() || modelId;
}

export function multiplierOf(r: Resistance): number {
  if (r.tested <= 0) return 0.55;
  return 0.55 + rateOf(r) * 1.55;
}

export function seedFromBoard(models: BoardModelRow[]): ModelSeed[] {
  return models.map((m, i) => {
    const r = { tested: m.tested, fooled: m.fooled };
    const held = heldOf(r);
    return {
      modelId: m.model,
      label: shortModelLabel(m.model),
      tested: m.tested,
      fooled: m.fooled,
      held,
      multiplier: multiplierOf(r),
      tier: tierOf(r),
      accentPalette: (i % 3) as 0 | 1 | 2,
      baseResilience: rateOf(r),
    };
  });
}

export function tickFromRecent(row: { duel_id: string; model: string; verdict: string; text?: string }): DecisionTick {
  const wasFooled = row.verdict === "fooled";
  const hint = row.text?.slice(0, 96);
  return {
    id: `row:${row.duel_id}:${row.model}:${row.verdict}`,
    modelId: row.model,
    timestamp: Date.now(),
    stakeDelta: wasFooled ? -1 : 1,
    wasFooled,
    duelId: row.duel_id,
    ...(hint ? { promptHint: hint } : {}),
    simulated: true,
  };
}

const SIM_PROMPTS = [
  "Unverified flash: rate-cut rumor from an unsigned handle",
  "Source spoof: governance multisig rotation claim",
  "Credibility strip: macro print with no signature",
  "Latency trap: bridge-pause claim from an unindexed relay",
];

/** Sim-round think window before held/fooled lands (seconds). */
export const SIM_THINK_SEC = 0.55;
export const SIM_HELD_SEC = 1.4;
export const SIM_FOOLED_SEC = 1.75;

export class ArenaSimulation {
  creatures: CreatureBody[] = [];
  /** Decorative school / roamers — not hit-tested as duel models, no fake LIVE money. */
  fauna = new AmbientFauna();
  ripples: PredationRipple[] = [];
  positions: SimStake[] = [];
  width = 1280;
  height = 720;
  /** Fixed dataset decision count for the telemetry pill. */
  datasetRows = 0;
  /** Catalog available for slot swaps (board-grounded). */
  catalog: ModelSpec[] = [];
  /** Outcomes waiting on thinkTimer; same frame path as dock logos. */
  private pendingRound: DecisionTick[] | null = null;

  constructor(width: number, height: number, seeds: ModelSeed[] = [], datasetRows = 0, catalog: ModelSpec[] = []) {
    this.width = width;
    this.height = height;
    this.datasetRows = datasetRows;
    this.catalog = catalog;
    this.fauna = new AmbientFauna(width, height);
    this.fauna.ensureSchool(false);
    if (seeds.length >= 2) this.setDuelFromSeeds(seeds[0]!, seeds[1]!);
    else this.initFromSeeds(seeds);
  }

  initFromSeeds(seeds: ModelSeed[]): void {
    if (!seeds.length) {
      this.creatures = [];
      return;
    }
    const n = seeds.length;
    this.creatures = seeds.map((s, i) => this.bodyFromSeed(s, i, n > 2));
    this.rebalancePools();
  }

  /** Pin exactly two models as the duel field (contract is 2-slot). */
  setDuelFromSeeds(left: ModelSeed, right: ModelSeed): void {
    this.creatures = [this.bodyFromSeed(left, 0, false), this.bodyFromSeed(right, 1, false)];
    this.rebalancePools();
  }

  setDuelModels(left: ModelSpec, right: ModelSpec): void {
    this.setDuelFromSeeds(this.specToSeed(left), this.specToSeed(right));
  }

  swapSlotModel(slot: 0 | 1, spec: ModelSpec): void {
    const other = this.creatures[slot === 0 ? 1 : 0];
    if (other && other.modelId === spec.modelId) return;
    const body = this.bodyFromSeed(this.specToSeed(spec), slot, false);
    // Keep roughly the same screen slot
    if (this.creatures[slot]) {
      body.x = this.creatures[slot]!.x;
      body.y = this.creatures[slot]!.y;
    }
    this.creatures[slot] = body;
    this.rebalancePools();
  }

  private specToSeed(spec: ModelSpec): ModelSeed {
    const r = { tested: spec.tested, fooled: spec.fooled };
    return {
      modelId: spec.modelId,
      label: spec.name,
      tested: spec.tested,
      fooled: spec.fooled,
      held: spec.held,
      multiplier: multiplierOf(r),
      tier: tierOf(r),
      accentPalette: spec.accentPalette,
      baseResilience: spec.baseResilience,
    };
  }

  private bodyFromSeed(s: ModelSeed, slot: number, field: boolean): CreatureBody {
    const angle = field ? (slot / Math.max(1, 4)) * Math.PI * 2 : 0;
    const x = field ? this.width * (0.5 + Math.cos(angle) * 0.28) : this.width * (slot === 0 ? 0.34 : 0.68);
    const y = field ? this.height * (0.5 + Math.sin(angle) * 0.2) : this.height * (slot === 0 ? 0.42 : 0.52);
    const liq = 200 + s.held * 40;
    return {
      ...s,
      recentEvents: [],
      poolLiquidity: liq,
      poolShare: 0.5,
      x,
      y,
      vx: slot === 0 ? 74 : -58,
      vy: slot === 0 ? -16 : 20,
      swimPhase: slot * 2.3,
      thinkTimer: 0,
      heldTimer: 0,
      fooledTimer: 0,
      lungeTimer: 0,
    };
  }

  private rebalancePools(): void {
    const total = this.creatures.reduce((s, c) => s + c.poolLiquidity, 0) || 1;
    for (const c of this.creatures) c.poolShare = c.poolLiquidity / total;
  }

  resize(width: number, height: number): void {
    // Ignore degenerate layout passes. Clamping width to 320 while scaling by
    // width/800 used to crush duelists into the corner on the first paint.
    if (width < 80 || height < 80) return;
    const sx = this.width > 0 ? width / this.width : 1;
    const sy = this.height > 0 ? height / this.height : 1;
    this.width = width;
    this.height = height;
    for (const c of this.creatures) {
      c.x *= sx;
      c.y *= sy;
    }
    this.fauna.resize(width, height);
    // Recover if a prior bad scale left everyone in the top-left corner.
    const crushed = this.creatures.length > 0 && this.creatures.every((c) => c.x < 48 && c.y < 48);
    if (crushed) {
      for (let i = 0; i < this.creatures.length; i++) {
        const c = this.creatures[i]!;
        c.x = width * (i === 0 ? 0.34 : 0.68);
        c.y = height * (i === 0 ? 0.42 : 0.52);
      }
    }
  }

  /**
   * Local sim round: each creature draws hold/fool from its measured resilience.
   * Outcomes sit in a short think window (dock logos scan), then ingest on the
   * same path as creature held/fooled. `thinkSec <= 0` ingests immediately
   * (tests / prefers-reduced-motion). Does not claim a live enclave feed.
   */
  triggerSimRound(boostedModelId?: string, stakeBoost = 0, thinkSec = SIM_THINK_SEC): DecisionTick[] {
    if (this.pendingRound) return this.pendingRound;
    const out: DecisionTick[] = [];
    const stamp = Date.now();
    for (const c of this.creatures) {
      const bonus = c.modelId === boostedModelId ? Math.min(0.08, stakeBoost / 1000) : 0;
      const resilience = Math.min(0.98, c.baseResilience + bonus);
      const wasFooled = Math.random() > resilience;
      const hint = SIM_PROMPTS[Math.floor(Math.random() * SIM_PROMPTS.length)]!;
      const evt: DecisionTick = {
        id: `sim:${stamp}:${c.modelId}:${wasFooled ? "f" : "h"}`,
        modelId: c.modelId,
        timestamp: stamp,
        stakeDelta: wasFooled ? -1 : 1,
        wasFooled,
        promptHint: hint,
        simulated: true,
      };
      out.push(evt);
    }
    if (thinkSec <= 0) {
      for (const evt of out) this.ingestTick(evt);
      return out;
    }
    for (const c of this.creatures) {
      c.thinkTimer = thinkSec;
      c.heldTimer = 0;
      c.fooledTimer = 0;
    }
    this.pendingRound = out;
    return out;
  }

  /** Apply queued sim outcomes immediately (tests / reduced-motion snap). */
  flushPendingRound(): DecisionTick[] {
    if (!this.pendingRound) return [];
    const out = this.pendingRound;
    this.pendingRound = null;
    for (const c of this.creatures) c.thinkTimer = 0;
    for (const evt of out) this.ingestTick(evt);
    return out;
  }

  get hasPendingRound(): boolean {
    return this.pendingRound !== null;
  }

  /** Sim-only stake chip: nudges pool liquidity and fires a sim round. Not on-chain. */
  placeSimStake(modelId: string, stake: number, thinkSec = SIM_THINK_SEC): SimStake | null {
    const target = this.creatures.find((c) => c.modelId === modelId);
    if (!target || stake <= 0) return null;
    const entryOdds = Number((1 / Math.max(0.08, target.poolShare)).toFixed(2));
    target.poolLiquidity += stake;
    this.rebalancePools();
    const position: SimStake = {
      id: `simstake:${Date.now()}:${modelId}`,
      modelId: target.modelId,
      modelLabel: target.label,
      stake,
      entryOdds,
      timestamp: Date.now(),
    };
    this.positions = [position, ...this.positions.slice(0, 9)];
    this.triggerSimRound(modelId, stake, thinkSec);
    return position;
  }

  ingestTick(event: DecisionTick): void {
    const actor = this.creatures.find((c) => c.modelId === event.modelId);
    if (!actor) return;
    actor.recentEvents = [event, ...actor.recentEvents.slice(0, 29)];

    actor.thinkTimer = 0;
    if (event.wasFooled) {
      actor.fooled += 1;
      actor.tested += 1;
      actor.fooledTimer = SIM_FOOLED_SEC;
      actor.heldTimer = 0;
      actor.multiplier = Math.max(0.48, actor.multiplier - 0.14);
      const opponent = this.creatures.find((c) => c.modelId !== actor.modelId);
      if (opponent) {
        const stolen = Math.min(actor.poolLiquidity * 0.12, 45);
        actor.poolLiquidity = Math.max(80, actor.poolLiquidity - stolen);
        opponent.poolLiquidity += stolen;
        opponent.lungeTimer = 1.35;
      }
    } else {
      actor.tested += 1;
      actor.held += 1;
      actor.heldTimer = SIM_HELD_SEC;
      actor.fooledTimer = 0;
      actor.multiplier = Math.min(2.75, actor.multiplier + 0.09);
      const opponent = this.creatures.find((c) => c.modelId !== actor.modelId);
      if (
        opponent &&
        mayEat({ tested: actor.tested, fooled: actor.fooled }, { tested: opponent.tested, fooled: opponent.fooled })
      ) {
        actor.lungeTimer = 1.25;
      }
    }
    const r = { tested: actor.tested, fooled: actor.fooled };
    actor.held = heldOf(r);
    actor.tier = tierOf(r);
    actor.baseResilience = rateOf(r);
    this.rebalancePools();
  }

  step(dt: number, timeSec: number): void {
    const margin = 115;
    const bottomHudReserve = 150;

    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i]!;
      c.thinkTimer = Math.max(0, c.thinkTimer - dt);
      c.heldTimer = Math.max(0, c.heldTimer - dt);
      c.fooledTimer = Math.max(0, c.fooledTimer - dt);
      c.lungeTimer = Math.max(0, c.lungeTimer - dt);
    }

    // Reduced motion (dt===0): snap think → outcome. Else resolve when think ends.
    if (this.pendingRound && (dt <= 0 || this.creatures.every((c) => c.thinkTimer <= 0))) {
      this.flushPendingRound();
    }

    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i]!;

      let steerX = Math.cos(timeSec * 0.44 + i * 2.1) * 28;
      let steerY = Math.sin(timeSec * 0.37 + i * 1.7) * 22;

      for (let j = 0; j < this.creatures.length; j++) {
        if (i === j) continue;
        const other = this.creatures[j]!;
        const dx = other.x - c.x;
        const dy = other.y - c.y;
        const dist = Math.max(1, Math.hypot(dx, dy));

        if (c.multiplier > other.multiplier * 1.15 && (c.lungeTimer > 0 || dist < 440)) {
          const chaseStrength = c.lungeTimer > 0 ? 190 : 80;
          steerX += (dx / dist) * chaseStrength;
          steerY += (dy / dist) * chaseStrength;
          if (dist < 68 && c.lungeTimer > 0) {
            c.lungeTimer = 0;
            this.ripples.push({
              x: other.x,
              y: other.y,
              radius: 12,
              maxRadius: 165,
              alpha: 1,
              accentPalette: c.accentPalette,
            });
            other.vx = (dx / dist) * 195;
            other.vy = (dy / dist) * 195;
          }
        } else if (other.multiplier > c.multiplier * 1.15 && dist < 380) {
          const fleeStrength = c.fooledTimer > 0 ? 205 : 115;
          steerX -= (dx / dist) * fleeStrength;
          steerY -= (dy / dist) * fleeStrength;
        }
      }

      if (c.x < margin) steerX += ((margin - c.x) / margin) * 190;
      if (c.x > this.width - margin) steerX -= ((c.x - (this.width - margin)) / margin) * 190;
      if (c.y < margin) steerY += ((margin - c.y) / margin) * 190;
      if (c.y > this.height - bottomHudReserve) {
        steerY -= ((c.y - (this.height - bottomHudReserve)) / bottomHudReserve) * 210;
      }

      c.vx += steerX * dt;
      c.vy += steerY * dt;
      const maxSpeed = c.lungeTimer > 0 ? 175 : c.fooledTimer > 0 ? 155 : 96;
      const minSpeed = 40;
      const speed = Math.hypot(c.vx, c.vy);
      if (speed > maxSpeed) {
        c.vx = (c.vx / speed) * maxSpeed;
        c.vy = (c.vy / speed) * maxSpeed;
      } else if (speed < minSpeed && speed > 1e-4) {
        c.vx = (c.vx / speed) * minSpeed;
        c.vy = (c.vy / speed) * minSpeed;
      }
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.swimPhase += dt * (4.2 + (speed / maxSpeed) * 4.5);
    }

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i]!;
      r.radius += dt * 190;
      r.alpha = Math.max(0, 1 - r.radius / r.maxRadius);
      if (r.alpha <= 0.01) this.ripples.splice(i, 1);
    }

    // Ecosystem fillers: school + periodic large/apex (never claim live outsider money).
    this.fauna.step(dt, timeSec, this.creatures);
  }

  hitTest(x: number, y: number, maxDist = 140): CreatureBody | null {
    let best: CreatureBody | null = null;
    let bestDist = maxDist;
    for (const c of this.creatures) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }
}
