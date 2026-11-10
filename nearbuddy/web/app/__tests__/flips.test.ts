// GET /api/flips' body from plain inputs: the replay list (decided chain records first, then the dataset's answered
// attacks) and the saboteurs board ranked by Flipped.
import { expect, test } from "bun:test";
import { flipsCache, replay, saboteurs } from "../api/flips";
import type { Chaos } from "../lib/abi/arena";
import type { Attack } from "../lib/fool";

const NEAR = 10n ** 24n;
const rec = (injector: string, outcome: Chaos["outcome"], extra: Partial<Chaos> = {}): Chaos => ({
  arm: "Cue",
  at: "1",
  claimed: false,
  decided_by: outcome === "Flipped" || outcome === "Held" ? "7" : null,
  headline: `${injector} ${outcome}`,
  injector,
  kind: "Long",
  next: outcome === "Flipped" ? "Long" : "Short",
  outcome,
  payout: String(NEAR / 10n),
  prev: "Short",
  stake: String(NEAR / 10n),
  target: "T=",
  ...extra,
});
const row = (duel: string, verdict: Attack["verdict"], text: string): Attack => ({
  duel_id: duel,
  model: "Qwen/Qwen3.8-27B",
  agent_pk: "T=",
  text,
  pushed: "Long",
  test: "against",
  before: "Short",
  after: verdict === "fooled" ? "Long" : "Short",
  verdict,
  reply: `words ${duel}`,
  tx: null,
});

test("replay: decided chain records newest first with stake and payout, then dataset attacks with the words", () => {
  const chain = [
    { duel: "540", records: [rec("a.testnet", "Expired"), rec("b.testnet", "Flipped", { payout: String(7n * NEAR) })] },
    { duel: "537", records: [rec("a.testnet", "Held"), rec("c.testnet", "NoTrial")] },
  ];
  const data = [row("462", "held", "old lie"), row("461", "untested", "skipped"), row("460", "fooled", "flip lie")];
  const out = replay(chain, data, (pk) => (pk === "T=" ? "Qwen/Qwen3.8-27B" : null));
  expect(out.map((f) => [f.duel, f.verdict, f.injector])).toEqual([
    ["540", "fooled", "b.testnet"],
    ["537", "held", "a.testnet"],
    ["462", "held", null],
    ["460", "fooled", null],
  ]);
  expect(out[0]).toMatchObject({
    model: "Qwen/Qwen3.8-27B",
    payout: String(7n * NEAR),
    reply: null,
    after: "Long",
    index: 1, // (duel, index) names a chain record
  });
  expect(out[2]).toMatchObject({ reply: "words 462", stake: null, payout: null });
  // at most n from each source
  expect(replay(chain, data, () => null, 1).map((f) => f.duel)).toEqual(["540", "462"]);
  // an attack the chain lists already is not repeated from the dataset
  const same = replay(
    [{ duel: "462", records: [rec("a.testnet", "Held", { headline: "old lie" })] }],
    data,
    () => null,
  );
  expect(same.filter((f) => f.duel === "462")).toHaveLength(1);
  expect(replay([], [], () => null)).toEqual([]);
});

test("saboteurs: ranked by Flipped, then paid, then attacks; placebo controls are not counted", () => {
  const chain = [
    {
      duel: "9",
      records: [
        rec("a.testnet", "Flipped", { payout: String(2n * NEAR) }),
        rec("b.testnet", "Flipped"),
        rec("c.testnet", "Expired"),
        rec("c.testnet", "Expired"),
        rec("owner.testnet", "NoTrial", { kind: "Placebo", stake: "0", payout: "0" }),
      ],
    },
    { duel: "8", records: [rec("b.testnet", "Held", { payout: "0" }), rec("a.testnet", "NoTrial")] },
  ];
  const s = saboteurs(chain);
  expect(s.map((x) => [x.account, x.flipped, x.held, x.attacks])).toEqual([
    ["a.testnet", 1, 0, 2],
    ["b.testnet", 1, 1, 2],
    ["c.testnet", 0, 0, 2],
  ]);
  expect(s[0]).toMatchObject({ staked: String(NEAR / 5n), paid: String(2n * NEAR + NEAR / 10n) });
  expect(saboteurs([])).toEqual([]);
});

test("a chain failure serves the last good body, and the dead RPC is asked again only after the negative TTL", async () => {
  let t = 0;
  let builds = 0;
  const answers: { body: string; ok: boolean }[] = [
    { body: "good-1", ok: true },
    { body: "dataset-only", ok: false }, // the chain read failed: saboteurs [] and chain_error
    { body: "good-2", ok: true },
  ];
  const serve = flipsCache(
    async () => answers[builds++]!,
    60_000,
    10_000,
    () => t,
  );
  expect(await serve()).toBe("good-1");
  t = 30_000;
  expect(await serve()).toBe("good-1"); // fresh: no build
  expect(builds).toBe(1);
  t = 61_000;
  expect(await serve()).toBe("good-1"); // the rebuild failed: the last good body, not an empty board
  expect(builds).toBe(2);
  t = 65_000;
  expect(await serve()).toBe("good-1"); // inside the negative TTL: no rebuild against the dead RPC
  expect(builds).toBe(2);
  t = 72_000;
  expect(await serve()).toBe("good-2");
  expect(builds).toBe(3);
  // never a good body yet: the failed one is what there is, still cached for the negative TTL
  let n = 0;
  const cold = flipsCache(
    async () => ({ body: `failed-${++n}`, ok: false }),
    60_000,
    10_000,
    () => t,
  );
  expect(await cold()).toBe("failed-1");
  expect(await cold()).toBe("failed-1");
  t += 10_001;
  expect(await cold()).toBe("failed-2");
});

test("concurrent requests share one build", async () => {
  let builds = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const serve = flipsCache(async () => {
    builds++;
    await gate;
    return { body: "b", ok: true };
  });
  const all = Promise.all([serve(), serve(), serve()]);
  release();
  expect(await all).toEqual(["b", "b", "b"]);
  expect(builds).toBe(1);
});
