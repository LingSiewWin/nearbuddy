import { expect, test } from "bun:test";
import { type AgentInfo, coachRows, MIN_MODEL_GAMES, modelRows, type Scored, within } from "../lib/standings";

const agents = new Map<string, AgentInfo>([
  ["pkA", { pk: "pkA", owner: "alice.testnet", model_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }],
  ["pkB", { pk: "pkB", owner: "bob.testnet", model_id: "Qwen/Qwen3.8-27B" }],
]);
const d = (i: number, pa: number, pb: number, winner: string | null): Scored => ({
  duel: String(i),
  a: "pkA",
  b: "pkB",
  pnl_a: pa,
  pnl_b: pb,
  winner,
});

test("mean, sample standard error and W-T-L per model", () => {
  const rows = modelRows([d(1, 10, -10, "pkA"), d(2, -4, 4, "pkB"), d(3, 6, 6, null)], agents);
  const ds = rows.find((r) => r.label === "DeepSeek-V4.1-Flash-1017");
  expect(ds?.n).toBe(3);
  expect(ds?.mean).toBeCloseTo(4, 6);
  expect(ds?.se).toBeCloseTo(4.163, 2); // sd 7.211 / sqrt(3)
  expect([ds?.w, ds?.t, ds?.l]).toEqual([1, 1, 1]);
  expect(ds?.thin).toBe(true); // 3 < MIN_MODEL_GAMES
});

test("one game has no standard error", () => {
  const [row] = modelRows([d(1, 10, -10, "pkA")], agents);
  expect(row?.se).toBeNull();
});

test("rows with enough games sort by mean and come before thin rows", () => {
  const many = Array.from({ length: MIN_MODEL_GAMES }, (_, i) => d(i, i % 2 ? 3 : 1, i % 2 ? -3 : -1, "pkA"));
  const rows = modelRows(many, agents);
  expect(rows.map((r) => r.thin)).toEqual([false, false]);
  expect(rows[0]?.mean).toBeGreaterThan(rows[1]?.mean ?? 0);
});

test("rows within the error band of their group leader share a group", () => {
  const row = (mean: number, se: number) =>
    ({ key: "", label: "", n: 40, mean, se, w: 0, t: 0, l: 0, thin: false, group: 0 }) as const;
  expect(within(row(54, 3), row(51, 3.5))).toBe(true); // 3 < 1.96·√(9 + 12.25) = 9.03
  expect(within(row(54, 3), row(30, 2))).toBe(false); // 24 > 1.96·√(9 + 4) = 7.07
});

test("a duel whose agent is unknown is skipped, not crashed on", () => {
  expect(modelRows([{ ...d(1, 5, -5, "pkA"), b: "pkZ" }], agents).map((r) => r.n)).toEqual([1]);
});

test("coach rows are per agent and labelled with the owner", () => {
  expect(
    coachRows([d(1, 10, -10, "pkA")], agents)
      .map((r) => r.label)
      .sort(),
  ).toEqual(["alice.testnet", "bob.testnet"]);
});

test("a match between two agents of one model is no game for that model, but is one for each coach", () => {
  const same = new Map(agents).set("pkB", {
    pk: "pkB",
    owner: "bob.testnet",
    model_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  });
  expect(modelRows([d(1, 10, -10, "pkA")], same)).toEqual([]);
  expect(coachRows([d(1, 10, -10, "pkA")], same).map((r) => r.n)).toEqual([1, 1]);
});
