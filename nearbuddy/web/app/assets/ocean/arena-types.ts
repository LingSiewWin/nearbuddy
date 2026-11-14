// Telemetry shapes for the ASCII arena. Pure data — no React, no fetch.
import type { TierId } from "./tiers";

export type ArenaTheme = "light" | "dark";

/** Spec for a selectable duel slot — always a real board / pinned model id. */
export type ModelSpec = {
  modelId: string;
  name: string;
  tested: number;
  fooled: number;
  held: number;
  /** held/tested; used as sim resilience. */
  baseResilience: number;
  accentPalette: 0 | 1 | 2;
};

/** One tick fed into the sim (replay row or local sim round). Always simulated unless marked otherwise. */
export type DecisionTick = {
  id: string;
  modelId: string;
  timestamp: number;
  stakeDelta: number;
  wasFooled: boolean;
  duelId?: string;
  promptHint?: string;
  /** Always true for local ticks; never present as a live enclave signature. */
  simulated: true;
};

export type ModelSeed = {
  modelId: string;
  label: string;
  tested: number;
  fooled: number;
  held: number;
  multiplier: number;
  tier: TierId;
  accentPalette: 0 | 1 | 2;
  baseResilience: number;
};

export type ModelAgentState = ModelSeed & {
  recentEvents: DecisionTick[];
  /** Sim-only liquidity for dock odds (not on-chain). */
  poolLiquidity: number;
  poolShare: number;
};

export type CreatureBody = ModelAgentState & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  swimPhase: number;
  /** Evaluating a headline (sim round latency). Shared with dock logos. */
  thinkTimer: number;
  /** Held pulse after a counted hold. Shared with dock logos. */
  heldTimer: number;
  fooledTimer: number;
  lungeTimer: number;
};

export type PredationRipple = {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
  accentPalette: 0 | 1 | 2;
  eventId?: string;
};

/** Local sim stake chip — does not move real NEAR. */
export type SimStake = {
  id: string;
  modelId: string;
  modelLabel: string;
  stake: number;
  entryOdds: number;
  timestamp: number;
};
