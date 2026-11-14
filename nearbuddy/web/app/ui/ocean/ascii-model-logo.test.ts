import { expect, test } from "bun:test";
import { LOGO_SIZE, logoStateOf, modelFamilyOf, renderLogoGrid } from "../../assets/ocean/ascii-model-logo";
import { catalogFromBoard } from "../../assets/ocean/catalog";
import { ArenaSimulation, seedFromBoard } from "../../assets/ocean/simulation";

test("modelFamilyOf maps arena ids to deepseek / qwen / glm / gemini / claude / generic", () => {
  expect(modelFamilyOf("deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe("deepseek");
  expect(modelFamilyOf("Qwen/Qwen3.8-27B")).toBe("qwen");
  expect(modelFamilyOf("z-ai/glm-5.3-flash")).toBe("glm");
  expect(modelFamilyOf("zhipu/glm-4")).toBe("glm");
  expect(modelFamilyOf("google/gemini-2.5-flash")).toBe("gemini");
  expect(modelFamilyOf("gemini-2.0-flash")).toBe("gemini");
  expect(modelFamilyOf("anthropic/claude-sonnet-4")).toBe("claude");
  expect(modelFamilyOf("claude-3-5-sonnet")).toBe("claude");
  expect(modelFamilyOf("acme/other-model")).toBe("generic");
});

test("brand templates render dense silhouettes for deepseek / glm / gemini / claude", () => {
  for (const family of ["deepseek", "glm", "gemini", "claude"] as const) {
    const idle = renderLogoGrid({ family, state: "idle", timer: 0, calm: true });
    expect(idle.length).toBe(LOGO_SIZE);
    expect(idle.every((row) => row.length === LOGO_SIZE)).toBe(true);
    expect(idle.some((row) => /[@8X%]/.test(row))).toBe(true);
  }
});

test("logoStateOf priority: thinking > fooled > held > idle", () => {
  expect(logoStateOf({ thinkTimer: 0.4, heldTimer: 1, fooledTimer: 1 })).toBe("thinking");
  expect(logoStateOf({ thinkTimer: 0, heldTimer: 1, fooledTimer: 0.5 })).toBe("fooled");
  expect(logoStateOf({ thinkTimer: 0, heldTimer: 0.8, fooledTimer: 0 })).toBe("held");
  expect(logoStateOf({ thinkTimer: 0, heldTimer: 0, fooledTimer: 0 })).toBe("idle");
});

test("renderLogoGrid returns 14×14 and calm skips scatter noise churn", () => {
  const idle = renderLogoGrid({ family: "deepseek", state: "idle", timer: 0, calm: true });
  expect(idle.length).toBe(LOGO_SIZE);
  expect(idle.every((row) => row.length === LOGO_SIZE)).toBe(true);
  expect(idle.some((row) => /[@8X%]/.test(row))).toBe(true);

  const fooledCalm = renderLogoGrid({
    family: "qwen",
    state: "fooled",
    timer: 1.5,
    timeSec: 0.3,
    calm: true,
  });
  const fooledWild = renderLogoGrid({
    family: "qwen",
    state: "fooled",
    timer: 1.5,
    timeSec: 0.3,
    calm: false,
  });
  expect(fooledCalm.join("\n")).not.toBe(fooledWild.join("\n"));
});

test("sim round think window shares timers with logoStateOf", () => {
  const board = [
    { model: "z-ai/glm-5.3-flash", tested: 22, fooled: 5 },
    { model: "Qwen/Qwen3.8-27B", tested: 22, fooled: 20 },
  ];
  const catalog = catalogFromBoard(board);
  const seeds = seedFromBoard(board);
  const sim = new ArenaSimulation(400, 240, [], 0, catalog);
  sim.setDuelFromSeeds(seeds[0]!, seeds[1]!);

  const ticks = sim.triggerSimRound();
  expect(ticks.length).toBe(2);
  expect(sim.hasPendingRound).toBe(true);
  expect(logoStateOf(sim.creatures[0]!)).toBe("thinking");
  expect(sim.creatures[0]!.recentEvents.length).toBe(0);

  sim.flushPendingRound();
  expect(sim.hasPendingRound).toBe(false);
  expect(sim.creatures[0]!.recentEvents.length).toBe(1);
  const left = sim.creatures[0]!;
  const state = logoStateOf(left);
  expect(state === "held" || state === "fooled").toBe(true);
});

test("thinkSec 0 ingests immediately for reduced motion / tests", () => {
  const board = [
    { model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", tested: 92, fooled: 37 },
    { model: "Qwen/Qwen3.6-35B-A3B-FP8", tested: 22, fooled: 22 },
  ];
  const seeds = seedFromBoard(board);
  const sim = new ArenaSimulation(400, 240, seeds);
  sim.triggerSimRound(undefined, 0, 0);
  expect(sim.hasPendingRound).toBe(false);
  expect(sim.creatures[0]!.recentEvents.length).toBe(1);
});
