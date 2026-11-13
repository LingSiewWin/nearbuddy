// The league body from raw duels: which match is live, which was last, who won, and what stays null while a match is
// only half open.
import { expect, test } from "bun:test";
import { build } from "../api/league";
import type { Duel } from "../lib/abi/arena";
import type { AgentInfo } from "../lib/league";

const agents = new Map<string, AgentInfo>([
  ["pkA", { pk: "pkA", owner: "alice.testnet", model_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }],
  ["pkB", { pk: "pkB", owner: "bob.testnet", model_id: "Qwen/Qwen3.8-27B" }],
]);
const intent = (pk: string, side: "Long" | "Short") =>
  ({
    agent_pk: pk,
    duel_id: "0",
    side,
    size_bps: 5000,
    nonce: "1",
    expires_at: "0",
    proof_hash: "",
  }) as Duel["last_intent_a"];
const duel = (id: string, over: Partial<Duel>): Duel =>
  ({
    id,
    a: "pkA",
    b: "pkB",
    symbol: "wrap.near",
    open_at: "1000",
    close_at: "2000",
    open_price: "340000000",
    injections: [],
    last_intent_a: intent("pkA", "Long"),
    last_intent_b: intent("pkB", "Short"),
    outcome: null,
    pool: "0",
    resolved: false,
    ...over,
  }) as Duel;
const outcome = (winner: string | null) => ({
  open_price: "340000000",
  close_price: "341000000",
  pnl_a: 15,
  pnl_b: -15,
  slashed: "0",
  injections: 2,
  winner,
});
const go = (duels: Duel[], now = 1500n) => build(duels, agents, now, "testnet", "arena.testnet");

test("the open match is live, the newest resolved one is last, and standings count resolved matches", () => {
  const l = go([duel("7", { resolved: true, outcome: outcome("pkA") }), duel("8", {})]);
  expect(l.live?.id).toBe("8");
  expect(l.last?.id).toBe("7");
  expect(l.last?.winner).toBe("A");
  expect(l.last?.a.pnl).toBe(15);
  expect(l.last?.attacks).toBe(2);
  expect(l.live?.a).toMatchObject({
    model: "DeepSeek-V4.1-Flash-1017",
    owner: "alice.testnet",
    side: "Long",
    pnl: null,
  });
  expect(l.models.map((r) => r.n)).toEqual([1, 1]);
});

test("a resolved match without a winner is a tie", () => {
  expect(go([duel("7", { resolved: true, outcome: outcome(null) })]).last?.winner).toBe("Tie");
});

test("a half-open match keeps what is missing null", () => {
  const l = go([duel("8", { open_price: null, last_intent_a: null })]);
  expect(l.live?.open_price).toBeNull();
  expect(l.live?.a.side).toBeNull();
  expect(l.live?.a.size_bps).toBeNull();
  expect(l.live?.b.side).toBe("Short");
});

test("an empty arena has no match and empty boards", () => {
  expect(build([], new Map(), 0n, "testnet", "x")).toMatchObject({ live: null, last: null, models: [], coaches: [] });
});

test("a match past its close and not yet resolved is closing: neither live nor last", () => {
  const l = go([duel("7", { resolved: true, outcome: outcome("pkA") }), duel("8", {})], 2000n);
  expect(l.live).toBeNull();
  expect(l.last?.id).toBe("7");
  expect(l.closing?.id).toBe("8");
  expect(l.closing?.a.side).toBe("Long");
});

test("a closed match that never got an opening price is not closing: no oracle answer can finish it", () => {
  const l = go([duel("7", { resolved: true, outcome: outcome("pkA") }), duel("8", { open_price: null })], 2000n);
  expect(l.closing).toBeNull();
  expect(l.last?.id).toBe("7");
});

test("a voided match (no oracle price) is a game for nobody", () => {
  const voided = { ...outcome(null), open_price: "0", close_price: "0", pnl_a: 0, pnl_b: 0 };
  const l = go([duel("7", { resolved: true, outcome: voided })]);
  expect(l.models).toEqual([]);
  expect(l.coaches).toEqual([]);
});
