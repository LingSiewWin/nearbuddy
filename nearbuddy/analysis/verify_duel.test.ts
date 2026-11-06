// verify_duel against four real testnet duels saved with `--save` (arena views, the duel's FastNEAR txs, the
// dataset rows): #373, two TEE agents, a decided duel; #363, red-team stub agents with commit-reveal, a consented
// open, 32 injections and a no-reveal forfeit (both deploy 14); #395, the first deploy-15 duel (per-duel lock, opener
// refund, third-party chaos); #401, a red-team deploy-15 duel with real self-chaos. Then each check is shown to fail
// on a one-field forgery, and the self-chaos rule also runs on a copy of #395 whose injection an agent's owner paid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { b64 } from "../packages/protocol/src/index.ts";
import { checkDuel, type Evidence, finishMath, type Line, pnlBps, price8, shieldGain } from "./verify_duel.ts";

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

// ---------------------------------------------------------------- deploy 15

test("#395 (deploy 15): lock timing, opener refund, shield and chaos deposits all pass", () => {
  const lines = checkDuel(load("395"));
  assert.deepEqual(fails(lines), []);
  for (const check of [
    "opener refund",
    "intent A timing",
    "intent A commit",
    "intent B commit",
    "winner and slash",
    "payout",
    "shield",
    "injection deposits",
  ])
    assert.deepEqual(result(lines, check), ["PASS"], check);
  // B revealed 69.2 s before close, before the 60 s lock opened: legal, so INFO, not FAIL
  assert.deepEqual(result(lines, "intent B timing"), ["INFO"]);
  assert.ok(lines.find((l) => l.check === "opener refund")!.detail.includes("storage 272 B"));
});

test("the v14 fixtures keep v14 rules: owner-paid chaos earned shield there", () => {
  // #363's winner A won on B's forfeit and got +32 shield from chaos its own owner paid; deploy 15 would give 0
  const l363 = checkDuel(load("363"));
  assert.deepEqual(result(l363, "shield"), ["PASS"]);
  assert.ok(l363.find((l) => l.check === "shield")!.detail.startsWith("v14 rule"));
  assert.ok(l363.find((l) => l.check === "shield")!.detail.includes("got A +32 B +0"));
  const as15 = load("363");
  as15.before!.config.intents_account = "intents.near";
  assert.deepEqual(fails(checkDuel(as15)), ["shield"]); // v15 math: forfeit win, no shield
});

test("lock timing: a reveal at or after close_at fails, a post inside the lock fails", () => {
  const e = load("395");
  const close = BigInt(e.now.duel!.close_at);
  const nonce = e.now.duel!.last_intent_a!.nonce; // the scored reveal (A revealed earlier intents too)
  const reveal = receipts(e, "reveal_intent").find((r) => args(r).signed.intent.nonce === nonce)!;
  reveal.execution_outcome.block_timestamp = String(close + 1_000_000_000n);
  assert.deepEqual(result(checkDuel(e), "intent A timing"), ["FAIL"]);
  const f = load("395");
  const commit = receipts(f, "commit_intent")
    .filter((r) => args(r).agent_pk === f.now.duel!.a)
    .at(-1)!;
  commit.execution_outcome.block_timestamp = String(close - 55_000_000_000n); // inside the 60 s lock, before the reveal
  assert.deepEqual(result(checkDuel(f), "intent A commit"), ["FAIL"]);
  const g = load("395");
  g.lock_ns = null; // a contract without duel_lock: no timing lines
  assert.deepEqual(result(checkDuel(g), "intent A timing"), []);
});

test("opener refund: a short refund fails; another arena receipt in the block makes it INFO", () => {
  const e = load("395");
  const transfer = e.txs
    .flatMap((t) => t.receipts)
    .filter((r) => r.receipt.predecessor_id === e.arena) // the arena's refund, not a system gas refund
    .flatMap((r) => r.receipt.receipt.Action?.actions ?? [])
    .find((a) => typeof a === "object" && a.Transfer) as { Transfer: { deposit: string } };
  transfer.Transfer.deposit = (BigInt(transfer.Transfer.deposit) - 1n).toString();
  assert.deepEqual(fails(checkDuel(e)), ["opener refund"]);
  const f = load("395");
  f.open_block!.others = 1;
  assert.deepEqual(result(checkDuel(f), "opener refund"), ["INFO"]);
});

test("self-chaos (deploy 15): an owner's deposit goes to owner fees, never the pool, and earns no shield", () => {
  // #395 with its one injection paid by the agents' owner: the pool never sees it, so the payout and the shield
  // change accordingly. Bonds after are recomputed with finish() math for a 0 pool.
  const e = load("395");
  const owner = e.now.a!.owner;
  const chaos = receipts(e, "inject_chaos")[0]!;
  chaos.receipt.predecessor_id = owner;
  const blk = chaos.execution_outcome.block_hash;
  e.chaos_pools![blk] = ["0", "0"];
  e.before!.duel!.pool = "0";
  const bonds: [bigint, bigint] = [BigInt(e.before!.a!.bond), BigInt(e.before!.b!.bond)];
  const m = finishMath(bonds, 0n, [4, -4], [false, false], e.before!.config.slash_bps, 1000);
  e.after!.a!.bond = m.after[0].toString();
  e.after!.b!.bond = m.after[1].toString();
  e.after!.a!.shield = e.before!.a!.shield!;
  const lines = checkDuel(e);
  assert.deepEqual(fails(lines), []);
  for (const check of ["payout", "shield", "injection deposits"])
    assert.deepEqual(result(lines, check), ["PASS"], check);
  assert.ok(lines.find((l) => l.check === "injection")!.detail.includes("-> owner fees (self-chaos"));
  // the same owner-paid deposit landing in the pool, or earning shield, is what deploy 15 forbids
  const into = structuredClone(e);
  into.chaos_pools![blk] = ["0", "98940000000000000000000"];
  assert.deepEqual(fails(checkDuel(into)), ["injection deposits"]);
  const shielded = structuredClone(e);
  shielded.after!.a!.shield = e.before!.a!.shield! + 1;
  assert.deepEqual(fails(checkDuel(shielded)), ["shield"]);
});

test("#401 (deploy 15, red team): real self-chaos goes to owner fees and earns the winner no shield", () => {
  // redteam1 owns both agents and paid one "self" injection at A; redteam2 paid four, two at each side; A won
  const lines = checkDuel(load("401"));
  assert.deepEqual(fails(lines), []);
  for (const check of ["opener refund", "payout", "shield", "injection deposits"])
    assert.deepEqual(result(lines, check), ["PASS"], check);
  assert.ok(lines.find((l) => l.check === "injection deposits")!.detail.includes("1 self-paid, pool unchanged"));
  assert.ok(lines.find((l) => l.check === "shield")!.detail.includes("expected A +2 B +0, got A +2 B +0"));
  assert.equal(lines.filter((l) => l.detail.includes("-> owner fees (self-chaos")).length, 1);
  // v14 math would credit the self-paid one too (+3) and count its deposit as pool money
  const as14 = load("401");
  delete as14.before!.config.intents_account;
  assert.deepEqual(fails(checkDuel(as14)), ["shield", "injection deposits"]);
});

test("shieldGain: injections at the winner; deploy 15 drops owner-paid ones and every forfeit win", () => {
  const t = [
    { target: "A", self: false },
    { target: "A", self: true },
    { target: "B", self: false },
  ];
  assert.equal(shieldGain(t, "A", false, false), 2); // v14: all chaos at the winner
  assert.equal(shieldGain(t, "A", true, false), 2); // v14 credited forfeit wins too
  assert.equal(shieldGain(t, "A", false, true), 1); // v15: the owner-paid one does not count
  assert.equal(shieldGain(t, "A", true, true), 0); // v15: no shield on a forfeit win
  assert.equal(shieldGain(t, null, false, true), 0); // tie
});
