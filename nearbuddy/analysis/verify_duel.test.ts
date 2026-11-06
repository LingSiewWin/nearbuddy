// verify_duel against two real testnet duels saved with `--save` (arena views, the duel's FastNEAR txs, the
// dataset rows): #373, two TEE agents, a decided duel; #363, red-team stub agents with commit-reveal, a consented
// open, 32 injections and a no-reveal forfeit. Then each check is shown to fail on a one-field forgery.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { b64 } from "../packages/protocol/src/index.ts";
import { checkDuel, type Evidence, finishMath, type Line, pnlBps, price8 } from "./verify_duel.ts";

const load = (id: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/verify_duel_${id}.json`, import.meta.url), "utf8")) as Evidence;
const result = (lines: Line[], check: string) => lines.filter((l) => l.check === check).map((l) => l.result);
const fails = (lines: Line[]) => lines.filter((l) => l.result === "FAIL").map((l) => l.check);
/** Every arena function-call receipt with this method, across the fixture's txs. */
const receipts = (e: Evidence, method: string) =>
  e.txs.flatMap((t) =>
    t.receipts.filter((r) =>
      r.receipt.receipt.Action?.actions.some((a) => typeof a === "object" && a.FunctionCall?.method_name === method),
    ),
  );
const fc = (r: Evidence["txs"][number]["receipts"][number]) =>
  r.receipt.receipt.Action!.actions.find((a) => typeof a === "object" && a.FunctionCall) as {
    FunctionCall: { method_name: string; args: string; deposit: string };
  };
const args = (r: Evidence["txs"][number]["receipts"][number]) =>
  JSON.parse(Buffer.from(fc(r).FunctionCall.args, "base64").toString());
const setArgs = (r: Evidence["txs"][number]["receipts"][number], v: unknown) => {
  fc(r).FunctionCall.args = Buffer.from(JSON.stringify(v)).toString("base64");
};
/** The post_intent receipt of A's scored intent (A posted earlier ones too). */
const scoredA = (e: Evidence) =>
  receipts(e, "post_intent").find((x) => args(x).signed.intent.nonce === e.now.duel!.last_intent_a!.nonce)!;

test("#373: two TEE agents, decided duel, every line passes", () => {
  const lines = checkDuel(load("373"));
  assert.deepEqual(fails(lines), []);
  for (const check of [
    "opened",
    "agent A registered",
    "agent B registered",
    "intent A signature",
    "intent A TEE kind",
    "intent A TEE signer",
    "intent A TEE signature",
    "intent A proof_hash",
    "intent A completion bytes",
    "intent B signature",
    "intent B completion bytes",
    "oracle open",
    "oracle close",
    "pnl A",
    "pnl B",
    "winner and slash",
    "payout",
    "injections",
  ])
    assert.deepEqual(result(lines, check), ["PASS"], check);
});

test("#363: commit-reveal, consented open, 32 injections, no-reveal forfeit, every line passes", () => {
  const lines = checkDuel(load("363"));
  assert.deepEqual(fails(lines), []);
  for (const check of ["opened", "intent A signature", "intent B signature", "no-reveal", "winner and slash", "payout"])
    assert.deepEqual(result(lines, check), ["PASS"], check);
  assert.equal(result(lines, "injection").length, 32);
  // B revealed, then committed again and never revealed: it forfeits whatever its pnl (+74 bps beats A's -74)
  assert.ok(lines.find((l) => l.check === "no-reveal")!.detail.includes("A false, B true"));
});

test("a forged agent signature fails the signature line", () => {
  const e = load("373");
  const r = scoredA(e);
  const a = args(r);
  const sig = b64.dec(a.signed.signature);
  sig[0]! ^= 1;
  a.signed.signature = b64.enc(sig);
  setArgs(r, a);
  assert.deepEqual(fails(checkDuel(e)), ["intent A signature"]);
});

test("a TEE proof from an unpinned signer, or over other hashes, fails", () => {
  const e = load("373");
  const signer = Object.keys(e.pinned)[0]!;
  e.pinned[signer] = false;
  assert.ok(fails(checkDuel(e)).some((c) => c.endsWith("TEE signer")));
  const f = load("373");
  const r = scoredA(f);
  const a = args(r);
  const h = b64.dec(a.tee.response_hash);
  h[0]! ^= 1;
  a.tee.response_hash = b64.enc(h);
  setArgs(r, a);
  // the row's response bytes no longer hash to the forged response_hash either
  assert.deepEqual(fails(checkDuel(f)), ["intent A TEE signature", "intent A proof_hash", "intent A completion bytes"]);
});

test("completion bytes that differ from the row, or no row at all", () => {
  const e = load("373");
  const ph = e.now.duel!.last_intent_a!.proof_hash;
  e.rows[ph] = { ...e.rows[ph], response_body: `${e.rows[ph]!.response_body} ` };
  assert.deepEqual(fails(checkDuel(e)), ["intent A completion bytes"]);
  const f = load("373");
  f.rows = {};
  assert.deepEqual(result(checkDuel(f), "intent A completion bytes"), ["SKIP"]);
});

test("a stored close price the oracle never sent fails the oracle and pnl lines", () => {
  const e = load("373");
  e.now.duel!.outcome!.close_price = "375370000";
  const f = fails(checkDuel(e));
  assert.ok(f.includes("oracle close"));
  const g = load("373");
  const r = receipts(g, "oracle_on_call").find((x) => args(x).msg === "close:373")!;
  const a = args(r);
  a.data.prices[0].price.multiplier = "375370000";
  setArgs(r, a);
  assert.deepEqual(fails(checkDuel(g)), ["oracle close"]);
});

test("an outcome pnl, slash or payout that finish() would not produce fails", () => {
  const e = load("373");
  e.now.duel!.outcome!.pnl_a = 28;
  assert.deepEqual(fails(checkDuel(e)), ["pnl A"]);
  const f = load("373");
  f.now.duel!.outcome!.slashed = "1";
  assert.deepEqual(fails(checkDuel(f)), ["winner and slash"]);
  const g = load("373");
  g.after!.a!.bond = (BigInt(g.after!.a!.bond) + 1n).toString();
  assert.deepEqual(fails(checkDuel(g)), ["payout"]);
});

test("only a receipt's own outcome counts, never the tx-level status", () => {
  // the reveal that was accepted panics in this copy: B's scored intent is no longer backed by a receipt
  const e = load("363");
  const reveal = receipts(e, "reveal_intent").find((x) => args(x).signed.intent.side === "Short")!;
  reveal.execution_outcome.outcome.status = { Failure: { ActionError: { index: 0 } } };
  assert.deepEqual(result(checkDuel(e), "intent B signature"), ["SKIP"]);
  // a failed inject_chaos receipt is not an injection
  const f = load("363");
  receipts(f, "inject_chaos")[0]!.execution_outcome.outcome.status = { Failure: {} };
  const lines = checkDuel(f);
  assert.equal(result(lines, "injection").length, 31);
  assert.deepEqual(result(lines, "injections"), ["SKIP"]);
});

test("the arithmetic matches the contract on hand-worked cases", () => {
  assert.equal(price8({ multiplier: "375033333", decimals: 8 }), 375033333n);
  assert.equal(price8({ multiplier: "3750333330", decimals: 9 }), 375033333n);
  assert.equal(price8({ multiplier: "37503", decimals: 4 }), 375030000n);
  const long = { side: "Long", size_bps: 5000, expires_at: "100" } as Parameters<typeof pnlBps>[0];
  assert.equal(pnlBps(long, 100n, 374426666n, 375033333n), 8); // 606667 * 5000 / 374426666 = 8.1
  assert.equal(pnlBps({ ...long!, side: "Short" }, 100n, 374426666n, 375033333n), -8); // truncates toward zero
  assert.equal(pnlBps({ ...long!, expires_at: "99" }, 100n, 1n, 2n), 0); // expired before close
  // tie: pool split, odd yocto to A
  assert.deepEqual(finishMath([10n, 20n], 5n, [8, 8], [false, false], 1000, 1000).after, [13n, 22n]);
  // B withholds: pays 10 % to A, then loses 10 % of what is left into the pool, A takes the pool
  const m = finishMath([1000n, 1000n], 100n, [-5, 5], [false, true], 1000, 1000);
  assert.deepEqual([m.after, m.slashed, m.aWins], [[1000n + 100n + 100n + 90n, 1000n - 100n - 90n], 90n, true]);
  // both withhold: both forfeit to owner fees, tie
  const both = finishMath([1000n, 2000n], 0n, [0, 0], [true, true], 1000, 500);
  assert.deepEqual([both.after, both.fees, both.aWins], [[950n, 1900n], 150n, null]);
});
