import { expect, test } from "bun:test";
import {
  FAUNA_CAPS,
  FAUNA_CAPS_CALM,
  GLYPHS,
  MOSAIC_RAMP,
  TIERS,
  forceApexEntrance,
  mayEat,
  mosaicGlyph,
  ribbonDensity,
  samplePrey,
  sampleReef,
  sampleShark,
  tierOf,
  wilson,
  type TierId,
} from "../../assets/ocean";
import { actorsAt } from "./field-paint";
import { eatVerdict } from "./eat";
import {
  ArenaSimulation,
  multiplierOf,
  seedFromBoard,
  shortModelLabel,
  tickFromRecent,
} from "../../assets/ocean/simulation";
import { catalogFromBoard } from "../../assets/ocean/catalog";
import {
  allocBuffers,
  rasterizeOceanField,
  CELL_SIZE,
  ASCII_RAMP,
  gaussianCount,
} from "../../assets/ocean/gaussian3d";

const BOARD = [
  { model: "z-ai/glm-5.3-flash", tested: 22, fooled: 5 },
  { model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", tested: 92, fooled: 37 },
  { model: "Qwen/Qwen3.8-27B", tested: 22, fooled: 20 },
  { model: "Qwen/Qwen3.6-35B-A3B-FP8", tested: 22, fooled: 22 },
];

test("every TierId has a non-empty glyph", () => {
  for (const t of TIERS) {
    const g = GLYPHS[t as TierId];
    expect(g.length).toBeGreaterThan(0);
    expect(g.every((line) => line.length > 0)).toBe(true);
  }
});

test("tierOf: thin sample stays shrimp; board models land on expected tiers", () => {
  expect(tierOf({ tested: 5, fooled: 0 })).toBe("shrimp");
  expect(tierOf({ tested: 22, fooled: 5 })).toBe("shark");
  expect(tierOf({ tested: 92, fooled: 37 })).toBe("dolphin");
  expect(tierOf({ tested: 22, fooled: 20 })).toBe("shrimp");
  expect(tierOf({ tested: 22, fooled: 22 })).toBe("shrimp");
});

test("mayEat: glm may eat Qwen; may not eat DeepSeek (CI overlap)", () => {
  const glm = { tested: 22, fooled: 5 };
  const deepseek = { tested: 92, fooled: 37 };
  const qwen = { tested: 22, fooled: 20 };
  expect(mayEat(glm, qwen)).toBe(true);
  expect(mayEat(glm, deepseek)).toBe(false);
  expect(mayEat(deepseek, qwen)).toBe(true);
  expect(eatVerdict(glm, deepseek).ok).toBe(false);
  expect(eatVerdict(glm, qwen).ok).toBe(true);
});

test("wilson stays inside [0,1]", () => {
  const w = wilson(17, 22);
  expect(w.lo).toBeGreaterThanOrEqual(0);
  expect(w.hi).toBeLessThanOrEqual(1);
  expect(w.lo).toBeLessThan(w.hi);
});

test("shark silhouette has a body at midships and empty far off the flank", () => {
  expect(sampleShark(0.4, 0)).toBe("body");
  expect(sampleShark(0.4, 0.9)).toBe("empty");
  expect(samplePrey(0.4, 0)).toBe("body");
  expect(sampleReef(0.35, 0)).toBe("body");
  expect(sampleReef(0.35, 0.95)).toBe("empty");
});

test("ambient fauna school fills tiny+mid caps; apex is forceable; duel stays 2-slot", () => {
  const sim = new ArenaSimulation(800, 480, seedFromBoard(BOARD.slice(0, 2)));
  const counts = sim.fauna.countsByBand();
  expect(counts.tiny).toBe(FAUNA_CAPS.tiny);
  expect(counts.mid).toBe(FAUNA_CAPS.mid);
  expect(sim.fauna.count).toBeLessThanOrEqual(FAUNA_CAPS.tiny + FAUNA_CAPS.mid + FAUNA_CAPS.large + FAUNA_CAPS.apex);
  expect(sim.creatures.length).toBe(2);

  const apex = forceApexEntrance(sim.fauna);
  expect(apex?.band).toBe("apex");
  expect(apex?.tier).toBe("megalodon");
  expect(apex?.decorative).toBe(true);
  expect(sim.fauna.countsByBand().apex).toBe(1);

  const shark = sim.fauna.spawnRoamer("large", true);
  expect(shark?.tier).toBe("shark");

  // Calm / reduced-motion trims movers
  sim.fauna.ensureSchool(true);
  const calm = sim.fauna.countsByBand();
  expect(calm.tiny).toBeLessThanOrEqual(FAUNA_CAPS_CALM.tiny);
  expect(calm.mid).toBeLessThanOrEqual(FAUNA_CAPS_CALM.mid);
  expect(calm.apex).toBe(0);
});

test("eat choreography clears prey around the bite", () => {
  const before = actorsAt(0.2, 400, 240).actors.filter((a) => a.kind === "prey" && a.alive);
  const after = actorsAt(0.7, 400, 240).actors.filter((a) => a.kind === "prey" && a.alive);
  expect(before.length).toBeGreaterThan(0);
  expect(after.length).toBe(0);
});

test("mosaic ramp and ribbon density stay in range", () => {
  expect(MOSAIC_RAMP.length).toBe(11);
  expect(mosaicGlyph(0, 0)).toBe(" ");
  expect(["X", "8", "@"]).toContain(mosaicGlyph(1, 1));
  const d = ribbonDensity(40, 80, 1.5);
  expect(d).toBeGreaterThanOrEqual(0);
  expect(d).toBeLessThanOrEqual(1);
});

test("catalog and seeds use only real board model ids", () => {
  const catalog = catalogFromBoard(BOARD);
  const seeds = seedFromBoard(BOARD);
  expect(catalog.map((c) => c.modelId)).toEqual(BOARD.map((m) => m.model));
  expect(catalog.some((c) => /near-ai\/|llama-3|gpt-oss|guarded-v2/.test(c.modelId))).toBe(false);
  expect(seeds.find((s) => s.modelId.includes("glm"))?.tier).toBe("shark");
  expect(shortModelLabel("a/b/c")).toBe("c");
  expect(multiplierOf({ tested: 22, fooled: 5 })).toBeGreaterThan(multiplierOf({ tested: 22, fooled: 20 }));
});

test("ArenaSimulation two-slot duel, sim round, sim stake", () => {
  const catalog = catalogFromBoard(BOARD);
  const seeds = seedFromBoard(BOARD);
  const sim = new ArenaSimulation(800, 480, [], 2799, catalog);
  sim.setDuelFromSeeds(seeds[0]!, seeds[2]!);
  expect(sim.creatures.length).toBe(2);
  expect(sim.creatures[0]!.poolLiquidity).toBeGreaterThan(0);

  const ticks = sim.triggerSimRound(undefined, 0, 0);
  expect(ticks.length).toBe(2);
  expect(ticks.every((t) => t.simulated)).toBe(true);
  expect(sim.creatures[0]!.recentEvents.length).toBeGreaterThan(0);

  const stake = sim.placeSimStake(sim.creatures[0]!.modelId, 25, 0);
  expect(stake?.stake).toBe(25);
  expect(sim.positions[0]?.modelId).toBe(sim.creatures[0]!.modelId);

  sim.swapSlotModel(1, catalog[1]!);
  expect(sim.creatures[1]!.modelId).toBe(catalog[1]!.modelId);

  const hit = sim.hitTest(sim.creatures[0]!.x, sim.creatures[0]!.y);
  expect(hit?.modelId).toBe(sim.creatures[0]!.modelId);

  const tick = tickFromRecent({ duel_id: "462", model: seeds[0]!.modelId, verdict: "held" });
  expect(tick.simulated).toBe(true);
  sim.step(0.016, 1);
  expect(Number.isFinite(sim.creatures[0]!.x)).toBe(true);
});

test("3D Gaussian rasterizer fills density with shade and zBuffer", () => {
  expect(CELL_SIZE).toBe(10);
  expect(ASCII_RAMP.length).toBe(11);
  expect(gaussianCount("shark")).toBeGreaterThan(200);
  expect(gaussianCount("shark")).toBeLessThan(420);
  expect(gaussianCount("shrimp")).toBeLessThan(220);

  const seeds = seedFromBoard([BOARD[0]!]);
  const sim = new ArenaSimulation(320, 240, seeds);
  const buffers = allocBuffers(Math.ceil(320 / CELL_SIZE), Math.ceil(240 / CELL_SIZE));
  rasterizeOceanField(buffers, sim.creatures, [], 0.5, 320, 240, sim.fauna.actors);
  let maxD = 0;
  let maxS = 0;
  let filled = 0;
  for (let i = 0; i < buffers.density.length; i++) {
    maxD = Math.max(maxD, buffers.density[i]!);
    maxS = Math.max(maxS, buffers.shade[i]!);
    if (buffers.density[i]! > 0.05) filled += 1;
  }
  expect(maxD).toBeGreaterThan(0.2);
  expect(maxS).toBeGreaterThan(0.2);
  // School + duelist should light more cells than plankton alone
  expect(filled).toBeGreaterThan(40);
});

test("resize ignores degenerate sizes and recovers crushed duelists", () => {
  const catalog = catalogFromBoard(BOARD);
  const sim = new ArenaSimulation(800, 520, [], 0, catalog);
  const ranked = [...catalog].sort((a, b) => b.baseResilience - a.baseResilience);
  sim.setDuelModels(ranked[0]!, ranked[ranked.length - 1]!);
  const before = sim.creatures.map((c) => ({ x: c.x, y: c.y }));
  sim.resize(1, 1);
  expect(sim.width).toBe(800);
  expect(sim.creatures[0]!.x).toBe(before[0]!.x);
  sim.resize(1326, 950);
  expect(sim.creatures[0]!.x).toBeGreaterThan(200);
  expect(sim.creatures[1]!.x).toBeGreaterThan(600);
});
