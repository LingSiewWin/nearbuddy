import { describe, expect, test } from "bun:test";
import type { MarketView, PredictionView } from "../lib/abi/predict";
import {
  crowdLine,
  DEPOSIT,
  mine,
  picksOf,
  predictCall,
  predictView,
  resultLine,
  split,
  steerLine,
} from "../lib/predict";

const market = (n: [number, number], outcome: MarketView["outcome"] = null): MarketView => ({
  duel_id: "567",
  index: 1,
  picks: [
    { pick: "Flipped", n: n[0] },
    { pick: "Held", n: n[1] },
  ],
  total: n[0] + n[1],
  settled: outcome !== null,
  outcome,
  scored: 0,
  steered_by: null,
  open_until_reveal: false,
});

describe("predict", () => {
  test("crowd split in whole percent, and the leading pick in words", () => {
    expect(split(market([2, 5])).map((s) => s.pct)).toEqual([29, 71]);
    expect(crowdLine(market([2, 5]))).toBe("71% say it will hold");
    expect(crowdLine(market([3, 1]))).toBe("75% say it will be fooled");
    expect(crowdLine(market([0, 0]))).toBeNull();
    expect(split(null)).toEqual([]);
  });

  test("a market says who can steer it or when it is not blind", () => {
    expect(steerLine(market([1, 1]))).toBeNull();
    expect(steerLine({ ...market([1, 1]), steered_by: "op.testnet" })).toContain("op.testnet");
    expect(steerLine({ ...market([1, 1]), open_until_reveal: true })).toContain("closes at the reveal");
    expect(steerLine(null)).toBeNull();
  });

  test("the viewer's call and its verdict", () => {
    const held: PredictionView[] = [
      { duel_id: "567", index: 1, pick: "Held", at: "1", verdict: "Right" },
      { duel_id: "567", index: null, pick: "A", at: "2", verdict: "Wrong" },
      { duel_id: "567", index: 0, pick: "Held", at: "3", verdict: null },
    ];
    expect(resultLine(mine(held, "567", 1))).toBe("you were right: you said it will hold");
    expect(resultLine(mine(held, "567", null))).toBe("you were wrong: you said A wins");
    expect(resultLine(mine(held, "567", 0))).toBe("you said it will hold · waiting for the model");
    expect(mine(held, "568", 1)).toBeNull();
    expect(resultLine(null)).toBeNull();
  });

  test("predict attaches exactly the contract's deposit with the generated arg names", () => {
    const c = predictCall("567", null, "Tie");
    expect(c).toMatchObject({ methodName: "predict", args: { duel_id: "567", index: null, pick: "Tie" } });
    expect(c.deposit).toBe(DEPOSIT);
    expect(DEPOSIT).toBe((3n * 10n ** 21n).toString());
    expect(picksOf(null)).toEqual(["A", "B", "Tie"]);
    expect(picksOf(0)).toEqual(["Flipped", "Held"]);
  });

  test("a view falls back to the second RPC and decodes the result bytes", async () => {
    const urls: string[] = [];
    const answer = [{ account: "a.testnet", count: 2, right: 1, streak: 0, best: 1 }];
    const fake = (async (url: string, init: RequestInit) => {
      urls.push(url);
      const body = JSON.parse(String(init.body));
      expect(body.params.method_name).toBe("get_board");
      expect(JSON.parse(atob(body.params.args_base64))).toEqual({ from: 0, limit: 10 });
      if (urls.length === 1) return new Response("rate limited", { status: 429 });
      const bytes = [...new TextEncoder().encode(JSON.stringify(answer))];
      return Response.json({ result: { result: bytes } });
    }) as unknown as typeof fetch;
    expect(await predictView("get_board", { from: 0, limit: 10 }, fake)).toEqual(answer);
    expect(urls.length).toBe(2);
  });
});
