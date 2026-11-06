// The follower page's readers and rows on real testnet txs (fixtures/follower2.json: nearbuddy-follower2.testnet's
// own txs and two solver settle_follow txs, one settled, one whose on_settle_follow panicked). Run: `cd web && bun test app`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  activityCells,
  type FollowerActivity,
  type MandateView,
  mandateCells,
  mandateState,
  settledFillCells,
  tokenAmount,
  tokenName,
} from "../cells";
import { followedAgents, followerActivity, settledFills } from "../lib/follower";
import type { Tx } from "../lib/verify";
import { type Cell, W } from "../tui";

const ARENA = "arena.nearbuddy-solver.testnet";
const F = "nearbuddy-follower2.testnet";
const QWEN = "8dPZ7znZ6ZopJrCBTF2vWMQTiHhHmuuVpsqnnhe3VgE=";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const fx = () =>
  JSON.parse(readFileSync(`${import.meta.dir}/fixtures/follower2.json`, "utf8")) as { own_txs: Tx[]; settle_txs: Tx[] };
const text = (cs: Cell[]) => cs.map((c) => (typeof c === "string" ? c : c.t)).join("");
const VW = W - 16 - 5;
const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const fromB64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString());
/** The arena receipt running `method` in tx `hash`. */
const receipt = (txs: Tx[], hash: string, method: string) =>
  txs
    .find((t) => t.transaction.hash.startsWith(hash))!
    .receipts.find((r) =>
      r.receipt.receipt.Action?.actions.some((a) => typeof a === "object" && a.FunctionCall?.method_name === method),
    )!;
const fc = (r: Tx["receipts"][number]) =>
  (
    r.receipt.receipt.Action!.actions.find((a) => typeof a === "object" && a.FunctionCall) as {
      FunctionCall: { args: string };
    }
  ).FunctionCall;

describe("followerActivity", () => {
  test("its own calls that succeeded, oldest first; the refused early withdraw is not one", () => {
    const a = followerActivity(fx().own_txs, ARENA, F);
    expect(a.map((x) => x.kind)).toEqual([
      "deposit",
      "follow",
      "deposit",
      "follow",
      "deposit",
      "follow",
      "deposit",
      "follow",
      "withdraw_token",
      "request_withdraw",
      "withdraw",
    ]);
    expect(a.map((x) => x.tx.slice(0, 6))).not.toContain("CR8sC5"); // withdraw: "withdrawal delay not elapsed"
    expect(a.find((x) => x.kind === "withdraw")).toMatchObject({ amount: "300000000000000000000000" }); // on_withdraw true
    expect(a.find((x) => x.kind === "withdraw_token")).toMatchObject({ token: USDC, amount: "370560" });
    expect(a.find((x) => x.kind === "deposit")).toMatchObject({ amount: "1000000000000000000000000" });
    expect(followedAgents(a)).toEqual([QWEN]);
    expect(followerActivity(fx().own_txs, ARENA, "someone-else.testnet")).toEqual([]);
  });
  test("a follow whose arena receipt panicked does not count, whatever the tx-level status", () => {
    const txs = fx().own_txs;
    receipt(txs, "2E8VhyMv", "follow").execution_outcome.outcome.status = { Failure: { ActionError: { index: 0 } } };
    expect(followerActivity(txs, ARENA, F).filter((x) => x.kind === "follow")).toHaveLength(3);
  });
});

describe("settledFills", () => {
  test("the settled batch counts; the batch whose on_settle_follow panicked ('no receipt') does not", () => {
    const fills = settledFills(fx().settle_txs, ARENA);
    expect(fills).toEqual([
      expect.objectContaining({
        tx: "GBBTWCWevc74eTa24dY26cvpv56qBWGiH7yp5iZ1Nit7",
        follower: F,
        agent_pk: QWEN,
        solver: "nearbuddy-solver.testnet",
        intent_nonce: "1793987081039",
        token: USDC,
        amount_in: "100000000000000000000000",
        amount_out: "370560",
      }),
    ]);
  });
  test("in a partly settled batch only the fills the report does not reject count", () => {
    const txs = fx().settle_txs;
    const r = receipt(txs, "GBBTWC", "on_settle_follow");
    const args = fromB64(fc(r).args);
    args.fills = [args.fills[0], { ...args.fills[0], intent_nonce: "7", amount_out: "1" }];
    fc(r).args = b64json(args);
    r.execution_outcome.outcome.status = {
      SuccessValue: b64json({ settled: 1, debited: "1", rejected: [[1, "over cap"]] }),
    };
    expect(settledFills(txs, ARENA).map((f) => f.intent_nonce)).toEqual(["1793987081039"]);
    r.execution_outcome.outcome.status = { SuccessValue: b64json({ settled: 1, debited: "1", rejected: [[0, "x"]] }) };
    expect(settledFills(txs, ARENA).map((f) => f.intent_nonce)).toEqual(["7"]);
  });
});

describe("rows", () => {
  const m: MandateView = {
    allowance: "500000000000000000000000",
    spent: "100000000000000000000000",
    per_tx_cap: "100000000000000000000000",
    allowed_tokens: [USDC],
    expires_at: "1794074586524000000",
    revoked: false,
    min_out_per_near: "3520320",
  };
  const NOW = 1793990000000;
  test("token amounts in display units; an unknown token shows raw units", () => {
    expect(tokenAmount(USDC, "370560")).toBe("0.3705");
    expect(tokenName(USDC)).toBe("USDC");
    expect(tokenAmount("nep141:wrap.near", "1500000000000000000000000")).toBe("1.5000");
    expect(tokenAmount("nep141:other.near", "42")).toBe("42");
    expect(tokenName("nep141:other.near")).toBe("other.near");
  });
  test("mandate state: active, expired, revoked", () => {
    expect(mandateState(m, NOW)).toBe("active");
    expect(mandateState(m, 1794074586525)).toBe("expired");
    expect(mandateState({ ...m, revoked: true }, NOW)).toBe("revoked");
  });
  test("every row fits the value column", () => {
    const long = "org/a-model-name-longer-than-the-column-allows";
    const mrow = text(mandateCells(QWEN, long, m, NOW));
    expect(mrow).toContain("active   cap 0.100  spent 0.100/0.500 NEAR");
    expect(mrow.length).toBeLessThanOrEqual(VW);
    expect(text(mandateCells(QWEN, null, null, NOW))).toContain("no mandate on chain");
    const f = settledFills(fx().settle_txs, ARENA)[0]!;
    const frow = text(settledFillCells(f, long));
    expect(frow).toContain(" 0.100 NEAR →    0.3705 USDC");
    expect(frow.length).toBeLessThanOrEqual(VW);
    for (const a of followerActivity(fx().own_txs, ARENA, F) as FollowerActivity[]) {
      const row = text(activityCells(a, a.agent_pk ? long : null));
      expect(row.length).toBeLessThanOrEqual(VW);
    }
    const tok = followerActivity(fx().own_txs, ARENA, F).find((x) => x.kind === "withdraw_token")!;
    expect(text(activityCells(tok, null))).toContain("token out     0.3705 USDC");
  });
});
