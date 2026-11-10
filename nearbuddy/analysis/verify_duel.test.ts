// verify_duel against four real testnet duels saved with `--save` (arena views, the duel's FastNEAR txs, the
// dataset rows): #373, two TEE agents, a decided duel; #363, red-team stub agents with commit-reveal, a consented
// open, 32 injections and a no-reveal forfeit (both deploy 14); #395, the first deploy-15 duel (per-duel lock, opener
// refund, third-party chaos); #401, a red-team deploy-15 duel with real self-chaos. Then each check is shown to fail
// on a one-field forgery, and the self-chaos rule also runs on a copy of #395 whose injection an agent's owner paid.
// Deploy 17 has no testnet duel yet: #401 recast as one (fixtures/verify_duel_v17.ts) checks its settlement against
// the get_chaos records, and the contract's own settlement unit tests are restated on finishMath.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Chaos } from "../packages/protocol/src/abi/arena.ts";
import { b64 } from "../packages/protocol/src/index.ts";
import { asDeploy17, TERMS } from "./fixtures/verify_duel_v17.ts";
import {
  checkDuel,
  type Evidence,
  finishMath,
  incomplete,
  judged,
  type Line,
  pnlBps,
  price8,
  shieldGain,
} from "./verify_duel.ts";

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

test("a close receipt not indexed yet makes the evidence incomplete, with the right payout reason", () => {
  for (const id of ["373", "363"]) {
    const full = load(id);
    assert.equal(incomplete(full), false);
    // right after resolution FastNEAR may not have the close callback yet: drop its tx
    const close = receipts(full, "oracle_on_call").find((r) => args(r).msg === `close:${id}`)!;
    const lag = { ...load(id), before: null, after: null };
    lag.txs = lag.txs.filter(
      (t) => !t.receipts.some((r) => r.execution_outcome.block_hash === close.execution_outcome.block_hash),
    );
    assert.equal(incomplete(lag), true);
    const payout = checkDuel(lag).find((l) => l.check === "payout")!;
    assert.equal(payout.result, "SKIP");
    assert.match(payout.detail, /not in the scanned txs yet/);
    // the receipt is there but its block's state was not served: incomplete, and the archival hint
    const pruned = { ...load(id), before: null };
    assert.equal(incomplete(pruned), true);
    assert.match(checkDuel(pruned).find((l) => l.check === "payout")!.detail, /VERIFY_ARCHIVAL_RPC/);
  }
  // nothing to wait for: an open duel, and a duel resolved without an outcome (testnet #0-21)
  const e = load("373");
  assert.equal(
    incomplete({ ...e, txs: [], now: { ...e.now, duel: { ...e.now.duel!, resolved: false, outcome: null } } }),
    false,
  );
  assert.equal(
    incomplete({ ...e, txs: [], before: null, now: { ...e.now, duel: { ...e.now.duel!, outcome: null } } }),
    false,
  );
});

test("intent timing is judged against the lock in force at open: duel_lock (deploy 15) or intent_lock_s before", () => {
  const e = load("395");
  const timed = (x: Evidence) => checkDuel(x).filter((l) => l.check.match(/^intent [AB] (timing|commit)$/));
  assert.ok(timed(e).length >= 2);
  assert.deepEqual(fails(checkDuel(e)), []);
  // opened before deploy 15: duel_lock answers today's global lock, which says nothing about this duel (testnet
  // #250 read 60 s and its intents, posted 47 s before close, would FAIL against it); the open block's
  // intent_lock_s is the lock that applied, so timing uses that and ignores duel_lock
  const { intents_account: _, intent_lock_s: _l, ...v14 } = e.open_block!.config;
  const at = (lock_s: number | undefined) => ({
    ...e,
    lock_ns: "999000000000", // today's global lock: must not be used
    open_block: { ...e.open_block!, config: lock_s === undefined ? v14 : { ...v14, intent_lock_s: lock_s } },
  });
  const lines60 = checkDuel(at(60));
  assert.deepEqual(result(lines60, "intent A timing"), ["PASS"]); // revealed 54.1 s before close, inside 60 s
  assert.deepEqual(result(lines60, "intent B timing"), ["INFO"]); // 69.2 s: before the lock opened
  assert.ok(lines60.find((l) => l.check === "intent A timing")!.detail.includes("(lock 60.0 s)"));
  const lines30 = checkDuel(at(30));
  assert.deepEqual(result(lines30, "intent A timing"), ["INFO"]); // 54.1 s is before a 30 s lock opened
  assert.deepEqual(result(lines30, "intent A commit"), ["PASS"]);
  const unknown = at(undefined);
  assert.deepEqual(timed(unknown), []);
  assert.deepEqual(result(checkDuel(unknown), "intent timing"), ["INFO"]); // no lock in the open block's config
  assert.deepEqual(result(checkDuel({ ...e, open_block: null }), "intent timing"), ["INFO"]); // config unknown
});

test("a duel that straddled deploy 15 gets no shield or deposit verdict, only a note", () => {
  // opened under v14, finished under v15 (or the reverse): injections and finish() ran under different rules
  for (const side of ["open", "callback"] as const) {
    const e = load("401");
    if (side === "open") delete e.open_block!.config.intents_account;
    else delete e.before!.config.intents_account;
    const lines = checkDuel(e);
    assert.deepEqual(fails(lines), [], side);
    assert.deepEqual(result(lines, "shield"), ["SKIP"], side);
    assert.deepEqual(result(lines, "injection deposits"), ["SKIP"], side);
    assert.ok(lines.find((l) => l.check === "shield")!.detail.includes("straddled deploy 15"), side);
    assert.deepEqual(result(lines, "payout"), ["PASS"], side); // finish()'s payout math is the same in both
    assert.ok(
      lines.some((l) => l.detail.includes("depending on the deploy it landed under")),
      side,
    );
  }
  // the evidence saved before open_block existed cannot tell, so it keeps the callback's rules
  const { open_block: _o, ...noOpen } = load("401");
  assert.deepEqual(result(checkDuel(noOpen), "shield"), ["PASS"]);
});

test("deploy 15: a failed read of an injection block, the open block or duel_lock is incomplete too", () => {
  for (const id of ["395", "401"]) assert.equal(incomplete(load(id)), false);
  const e = load("401");
  const blk = Object.keys(e.chaos_pools!)[0]!;
  const { [blk]: _, ...rest } = e.chaos_pools!;
  assert.equal(incomplete({ ...e, chaos_pools: rest }), true);
  assert.equal(incomplete({ ...load("395"), open_block: null }), true);
  assert.equal(incomplete({ ...load("395"), lock_ns: null }), true); // deploy 15 has duel_lock: null = a failed read
  // evidence saved before these fields existed is not incomplete for lacking them
  const { lock_ns: _l, chaos_pools: _c, open_block: _o, ...old } = load("395");
  assert.equal(incomplete(old as Evidence), false);
});

test("an operator-era duel closes on the operator's resolve receipt: complete, payout checked", () => {
  // testnet duels before #257 had no oracle callback: the operator key's signed `resolve` scored them. Recast #373's
  // close callback as such a receipt (same block, so the saved before/after state still applies).
  const e = load("373");
  const close = receipts(e, "oracle_on_call").find((r) => args(r).msg === "close:373")!;
  const o = e.now.duel!.outcome!;
  fc(close).FunctionCall.method_name = "resolve";
  setArgs(close, {
    resolution: { duel_id: "373", open_price: o.open_price, close_price: o.close_price },
    oracle_sig: "x",
  });
  assert.equal(incomplete(e), false);
  const lines = checkDuel(e);
  assert.deepEqual(result(lines, "oracle close"), ["SKIP"]); // no oracle callback, said as such
  assert.deepEqual(result(lines, "payout"), ["PASS"]);
  // a resolve for another duel does not close this one
  setArgs(close, {
    resolution: { duel_id: "372", open_price: o.open_price, close_price: o.close_price },
    oracle_sig: "x",
  });
  assert.equal(incomplete({ ...e, before: null }), true);
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
  // v14 math would credit the self-paid one too (+3) and count its deposit as pool money (a duel opened and
  // finished under v14; changing only one side is a straddle, tested below)
  const as14 = load("401");
  delete as14.before!.config.intents_account;
  delete as14.open_block!.config.intents_account;
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

// ---------------------------------------------------------------- deploy 17

const S = 99_110_000_000_000_000_000_000n; // #401's stake per third-party injection
const FEE = (S * 500n) / 10_000n;

test("deploy 17 (#401 recast): every stake settles by its get_chaos record, every line passes", () => {
  const lines = checkDuel(asDeploy17(load("401")));
  assert.deepEqual(fails(lines), []);
  for (const check of [
    "winner and slash",
    "payout",
    "chaos settlement",
    "shield",
    "injections",
    "chaos records",
    "injection deposits",
  ])
    assert.deepEqual(result(lines, check), ["PASS"], check);
  // held at the winner: +1; the owner's own held headline: none
  assert.ok(lines.find((l) => l.check === "shield")!.detail.includes("expected A +1 B +0, got A +1 B +0"));
  assert.ok(lines.find((l) => l.check === "chaos settlement")!.detail.includes("1 flipped, 2 held, 1 no trial"));
});

test("deploy 17: the deploy-16 pool rule fails, and so does each forged record", () => {
  const forged = (f: (e: Evidence) => void) => {
    const e = asDeploy17(load("401"));
    f(e);
    return fails(checkDuel(e));
  };
  // finish() under the pool rule: the winner takes pool + slash, no fee, no share, no resistance reward, shield +2
  const old = load("401").after!;
  assert.deepEqual(
    forged((e) => {
      e.after!.a!.bond = old.a!.bond;
      e.after!.b!.bond = old.b!.bond;
      e.after!.config.owner_fees = old.config.owner_fees;
    }),
    ["payout"],
  );
  assert.deepEqual(
    forged((e) => {
      e.after!.a!.shield = 2;
    }),
    ["shield"],
  );
  // a payout one yocto off, an outcome its own prev and next do not give, an outcome still pending
  assert.deepEqual(
    forged((e) => {
      e.chaos![3]!.payout = String(BigInt(e.chaos![3]!.payout) + 1n);
    }),
    ["chaos settlement"],
  );
  assert.deepEqual(
    forged((e) => {
      e.chaos![3]!.next = "Long"; // B never took the Short bait
    }),
    ["chaos settlement"],
  );
  assert.deepEqual(
    forged((e) => {
      e.chaos![4]!.outcome = "Pending";
    }),
    ["chaos settlement"],
  );
  // a record that is not its call: another headline, or a stake on the owner's own injection
  assert.deepEqual(
    forged((e) => {
      e.chaos![1]!.headline = "another headline";
    }),
    ["chaos records"],
  );
  // a stake the pool did not receive: the records' sums no longer match the pool, the bonds, or the payouts
  assert.ok(
    forged((e) => {
      e.chaos![2]!.stake = String(S - 1n);
    }).includes("injection deposits"),
  );
});

test("deploy 17: a void settles the headlines as on a tie, then splits what is left", () => {
  // #401 recast, voided instead of scored: no slash, no share; the flip at B is owed s - fee only, and the headline
  // that expired comes back whole (the oracle never answered: no fee), so owner fees gain one fee less
  const e = asDeploy17(load("401"));
  Object.assign(e.now.duel!.outcome!, { open_price: "0", close_price: "0", winner: null, slashed: "0" });
  e.chaos![3]!.payout = String(S - FEE);
  assert.equal(e.chaos![4]!.outcome, "Expired");
  e.chaos![4]!.payout = String(S);
  e.after!.config.owner_fees = String(BigInt(e.after!.config.owner_fees) - FEE);
  e.after!.a!.bond = String(BigInt(e.before!.a!.bond) + S - FEE); // the held stake less the fee; the pool is all stakes
  e.after!.b!.bond = e.before!.b!.bond;
  const lines = checkDuel(e);
  assert.deepEqual(fails(lines), []);
  assert.deepEqual(result(lines, "payout"), ["PASS"]);
  assert.deepEqual(result(lines, "chaos settlement"), ["PASS"]);
  assert.ok(lines.find((l) => l.check === "chaos settlement")!.detail.includes("but the expired ones (void: no fee)"));
  // the fee taken on the expired stake anyway (the rule before) fails the record and the owner fees
  const old = structuredClone(e);
  old.chaos![4]!.payout = String(S - FEE);
  assert.deepEqual(fails(checkDuel(old)), ["chaos settlement"]);
  old.chaos![4]!.payout = String(S);
  old.after!.config.owner_fees = String(BigInt(old.after!.config.owner_fees) + FEE);
  assert.deepEqual(fails(checkDuel(old)), ["payout"]);
  e.chaos![3]!.payout = String(S - FEE + 1n);
  assert.deepEqual(fails(checkDuel(e)), ["chaos settlement"]);
});

test("deploy 17 without its records: payout, records and deposits SKIP, and the evidence is incomplete", () => {
  const e = { ...asDeploy17(load("401")), chaos: null };
  const lines = checkDuel(e);
  assert.deepEqual(fails(lines), []);
  for (const check of ["payout", "chaos records", "injection deposits"])
    assert.deepEqual(result(lines, check), ["SKIP"], check);
  assert.equal(incomplete(e), true);
  assert.equal(incomplete(asDeploy17(load("401"))), false);
});

test("a deploy-16 duel read on a deploy-17 contract keeps its own rules, line for line", () => {
  // the contract that finished it had no chaos terms, and it has no records: nothing changes
  for (const id of ["363", "373", "395", "401"]) {
    const e = load(id);
    e.now.config.chaos = TERMS;
    e.chaos = [];
    assert.deepEqual(checkDuel(e), checkDuel(load(id)), id);
    assert.equal(incomplete(e), incomplete(load(id)), id);
  }
});

test("a deploy-16 duel whose close state is unreadable is not judged by today's deploy-17 config", () => {
  // the RPC has pruned the close block (before/after null): the open block and the empty records say deploy 16
  for (const id of ["363", "373", "395", "401"]) {
    const old = { ...load(id), before: null, after: null };
    const e = { ...load(id), before: null, after: null, chaos: [] };
    e.now.config.chaos = TERMS;
    assert.deepEqual(checkDuel(e), checkDuel(old), id);
    const noOpen = { ...e, open_block: null };
    assert.deepEqual(checkDuel(noOpen), checkDuel({ ...old, open_block: null }), `${id} without the open block`);
  }
  // still deploy 17 when the open block had the terms, or the duel has records
  const v17 = asDeploy17(load("401"));
  const recordsOnly = { ...v17, before: null, after: null };
  recordsOnly.open_block = null;
  assert.deepEqual(result(checkDuel(recordsOnly), "chaos records"), ["PASS"]);
});

test("owner fees: a mismatch fails, unless another arena receipt ran in the closing block (then INFO)", () => {
  const off = () => {
    const e = asDeploy17(load("401")); // fees > 0: every stake pays fee_bps
    e.after!.config.owner_fees = String(BigInt(e.after!.config.owner_fees) + 1n);
    return e;
  };
  assert.deepEqual(fails(checkDuel(off())), ["payout"]);
  assert.deepEqual(result(checkDuel(off()), "owner fees"), []);
  const e = off();
  const close = receipts(e, "oracle_on_call").find((r) => args(r).msg === `close:${e.duel_id}`)!;
  e.txs.push({
    transaction: { hash: "another-duel-finish" },
    receipts: [
      {
        receipt: {
          predecessor_id: "relayer.testnet",
          receiver_id: e.arena,
          receipt: {
            Action: {
              signer_id: "relayer.testnet",
              actions: [
                {
                  FunctionCall: {
                    method_name: "claim_owner_fees",
                    args: Buffer.from("{}").toString("base64"),
                    deposit: "0",
                  },
                },
              ],
            },
          },
        },
        execution_outcome: { ...close.execution_outcome, outcome: { logs: [], status: { SuccessValue: "" } } },
      },
    ],
  });
  const lines = checkDuel(e);
  assert.deepEqual(fails(lines), []);
  assert.deepEqual(result(lines, "payout"), ["PASS"]);
  assert.deepEqual(result(lines, "owner fees"), ["INFO"]);
  assert.ok(lines.find((l) => l.check === "owner fees")!.detail.includes("1 other arena receipts"));
  // the bonds are still judged: a bond one yocto off fails whatever else ran in the block
  e.after!.a!.bond = String(BigInt(e.after!.a!.bond) + 1n);
  assert.deepEqual(fails(checkDuel(e)), ["payout"]);
});

test("deploy 17 arithmetic: the contract's own settlement tests, restated", () => {
  const terms = { fee_bps: 500, share_bps: 5_000 };
  const pks: [string, string] = ["A", "B"];
  const one = (target: string, outcome: Chaos["outcome"], stake = S) => ({ target, stake: String(stake), outcome });
  const bonds: [bigint, bigint] = [10n ** 24n, 10n ** 24n];
  const slashed = bonds[0] / 10n;
  const run = (pnl: [number, number], records: ReturnType<typeof one>[], slashBps = 1_000) =>
    finishMath(bonds, S * BigInt(records.length), pnl, [false, false], slashBps, 1_000, { records, pks, terms });
  // a_flipped_target_that_loses_pays_the_injector_half_its_slash_on_top
  let m = run([-5, 5], [one("A", "Flipped")]);
  assert.deepEqual(m.after, [bonds[0] - slashed - slashed / 2n, bonds[1] + slashed]);
  assert.deepEqual([m.settled!.payouts, m.fees], [[S - FEE + slashed / 2n], FEE]);
  // a_flipped_target_that_wins_returns_the_stake_less_the_fee
  m = run([5, -5], [one("A", "Flipped")]);
  assert.deepEqual([m.after, m.settled!.payouts], [[bonds[0] + slashed, bonds[1] - slashed], [S - FEE]]);
  // a_held_headline_pays_the_target_a_resistance_reward
  m = run([5, -5], [one("A", "Held")]);
  assert.deepEqual(
    [m.after, m.settled!.payouts, m.fees],
    [[bonds[0] + slashed + S - FEE, bonds[1] - slashed], [0n], FEE],
  );
  // the_flip_share_never_takes_more_than_the_losers_bond: a 90 % slash leaves less than half of it
  m = run([-5, 5], [one("A", "Flipped")], 9_000);
  const big = (bonds[0] * 9_000n) / 10_000n;
  assert.deepEqual([m.after, m.settled!.payouts], [[0n, bonds[1] + big], [S - FEE + (bonds[0] - big)]]);
  // void_settles_the_headlines_as_a_tie: a held stake to its target less the fee, an expired one owed back whole
  // (the oracle never answered: no fee); on a scored tie the expired one pays the fee
  const records = [one("A", "Held"), one("A", "Pending")];
  m = finishMath(bonds, 2n * S, [0, 0], [false, false], 0, 0, { records, pks, terms, voided: true });
  assert.deepEqual([m.after, m.settled!.payouts, m.fees], [[bonds[0] + S - FEE, bonds[1]], [0n, S], FEE]);
  m = finishMath(bonds, 2n * S, [0, 0], [false, false], 0, 0, { records, pks, terms });
  assert.deepEqual([m.settled!.payouts, m.fees], [[0n, S - FEE], 2n * FEE]);
  // shares pro rata by stake in bps, rounded down: the dust stays in the loser's bond
  const x = 10n ** 23n;
  m = finishMath(bonds, 3n * x, [-5, 5], [false, false], 1_000, 0, {
    records: [one("A", "Flipped", x), one("A", "Flipped", 2n * x)],
    pks,
    terms,
  });
  const pot = slashed / 2n;
  const shares = [(pot * 3_333n) / 10_000n, (pot * 6_666n) / 10_000n];
  assert.deepEqual(m.settled!.payouts, [x - x / 20n + shares[0]!, 2n * x - x / 10n + shares[1]!]);
  assert.equal(m.after[0], bonds[0] - slashed - shares[0]! - shares[1]!);
  assert.ok(shares[0]! + shares[1]! < pot);
  // no chaos (deploy 16): the pool and the slash go whole to the winner, as before
  assert.deepEqual(finishMath(bonds, S, [5, -5], [false, false], 1_000, 1_000).after, [
    bonds[0] + S + slashed,
    bonds[1] - slashed,
  ]);
});

test("judged: an outcome must follow from the record's own kind, prev and next", () => {
  const r = (
    kind: Chaos["kind"],
    prev: Chaos["prev"],
    next: Chaos["next"],
    outcome: Chaos["outcome"],
    decided_by: Chaos["decided_by"] = null,
  ) => judged({ kind, prev, next, outcome, decided_by });
  assert.equal(r("Short", "Long", "Short", "Flipped"), true);
  assert.equal(r("Short", "Long", "Long", "Held"), true);
  assert.equal(r("Short", "Short", "Long", "NoTrial"), true); // already on the lie's side
  assert.equal(r("Short", null, "Short", "NoTrial"), true); // no call before the lie
  assert.equal(r("Placebo", "Long", "Short", "NoTrial"), true); // a placebo is never a trial
  // charged: the target replaced its held call unrevealed (prev hidden, null); the lie's side is a flip, never a hold
  assert.equal(r("Short", null, "Short", "Flipped"), true);
  assert.equal(r("Short", null, "Long", "NoTrial"), true);
  assert.equal(r("Short", null, "Long", "Held"), false);
  assert.equal(r("Short", null, "Long", "Flipped"), false);
  assert.equal(r("Placebo", null, "Short", "Flipped"), false); // a placebo has no lie's side
  // a replacement no longer voids: a decided outcome always has a next
  assert.equal(r("Short", null, null, "NoTrial"), false);
  // a keyless reply with no readable decision: no call, so the headlines it carried are no trial, never a flip
  assert.equal(r("Short", "Long", null, "NoTrial", "2"), true);
  assert.equal(r("Short", "Long", null, "Flipped", "2"), false);
  assert.equal(r("Short", "Long", null, "Held", "2"), false);
  assert.equal(r("Short", "Long", null, "Expired"), true);
  assert.equal(r("Short", "Long", "Long", "Flipped"), false);
  assert.equal(r("Short", "Short", "Short", "Flipped"), false);
  assert.equal(r("Placebo", "Long", "Long", "Held"), false);
  assert.equal(r("Short", "Long", "Short", "Expired"), false);
  // in a whole duel: #401 recast with B's flip charged (B replaced its held call unrevealed, so prev is null)
  const e = asDeploy17(load("401"));
  e.chaos![3]!.prev = null;
  assert.deepEqual(fails(checkDuel(e)), []);
  e.chaos![3]!.outcome = "Held"; // never a hold against a hidden call (the bonds then differ too)
  const line = checkDuel(e).find((l) => l.check === "chaos settlement")!;
  assert.equal(line.result, "FAIL");
  assert.ok(line.detail.includes("#3 Held does not follow from prev null and next Short"), line.detail);
});

test("shieldGain from deploy 17: only the Held records count", () => {
  const t = (["Held", "Flipped", "NoTrial", "Expired"] as const).map((outcome) => ({
    target: "A",
    self: false,
    outcome,
  }));
  assert.equal(shieldGain([...t, { target: "A", self: true, outcome: "Held" }], "A", false, true), 1);
  assert.equal(shieldGain(t, "A", true, true), 0); // a forfeit win
});

// Deploy 18: the first keyless duel, testnet nb-keyless-arena-1111.testnet #0 (two keyless agents on
// z-ai/glm-5.3-flash driven by packages/keeper, a headline planted at B), saved with --save.
test("keyless duel: every line passes, and a forged strategy, reveal or pin fails its line", () => {
  const e = load("keyless_0");
  const lines = checkDuel(e);
  assert.deepEqual(fails(lines), []);
  for (const s of ["A", "B"])
    for (const c of ["price", "request", "response", "TEE signer", "TEE signature", "proof_hash", "decision", "timing"])
      assert.deepEqual(result(lines, `keyless ${s} ${c}`), ["PASS"], `keyless ${s} ${c}`);
  const forged = (f: (x: Evidence) => void) => {
    const x = structuredClone(e);
    f(x);
    return fails(checkDuel(x));
  };
  const b = e.now.duel!.b;
  // the request is rebuilt from the strategy on chain: another strategy is another request, which the enclave
  // never signed and the intent's proof_hash does not commit to
  assert.deepEqual(
    forged((x) => {
      x.keyless![b]!.strategy = "Always long.";
    }),
    ["keyless B request", "keyless B TEE signature", "keyless B proof_hash"],
  );
  // a reveal of other bytes: they do not hash to the commit, and they read another decision
  assert.deepEqual(
    forged((x) => {
      const r = receipts(x, "reveal_completion").find((y) => args(y).agent === b)!;
      const content = JSON.stringify({ direction: "short", size_bps: 900 });
      const response = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
      setArgs(r, { ...args(r), response: b64.enc(new TextEncoder().encode(response)) });
    }),
    ["keyless B response", "keyless B TEE signature", "keyless B proof_hash", "keyless B decision"],
  );
  assert.deepEqual(
    forged((x) => {
      for (const k of Object.keys(x.pinned)) x.pinned[k] = false;
    }),
    ["keyless A TEE signer", "keyless B TEE signer"],
  );
});

// The one-step flow (submit_completion): testnet v2.nb-keyless-arena-1111.testnet #0, two keyless agents on
// DeepSeek-V4.1-Flash driven by packages/keeper, a headline planted at B.
test("one-step keyless duel: every line passes; a forged response, or a signer pinned to another model, fails", () => {
  const e = load("keyless_v2_0");
  const lines = checkDuel(e);
  assert.deepEqual(fails(lines), []);
  for (const s of ["A", "B"]) {
    for (const c of ["price", "request", "TEE signer", "TEE signature", "proof_hash", "decision", "timing"])
      assert.deepEqual(result(lines, `keyless ${s} ${c}`), ["PASS"], `keyless ${s} ${c}`);
    assert.deepEqual(result(lines, `keyless ${s} response`), ["INFO"], "one step: no commitment to match");
  }
  const forged = (f: (x: Evidence) => void) => {
    const x = structuredClone(e);
    f(x);
    return fails(checkDuel(x));
  };
  const b = e.now.duel!.b;
  assert.deepEqual(
    forged((x) => {
      const r = receipts(x, "submit_completion").find((y) => args(y).agent === b && args(y).seq === "2")!;
      const content = JSON.stringify({ direction: "short", size_bps: 900 });
      const response = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
      setArgs(r, { ...args(r), response: b64.enc(new TextEncoder().encode(response)) });
    }),
    ["keyless B TEE signature", "keyless B proof_hash", "keyless B decision"],
  );
  assert.deepEqual(
    forged((x) => {
      for (const k of Object.keys(x.model_signers!)) x.model_signers![k] = "z-ai/glm-5.3-flash";
    }),
    ["keyless A TEE signer", "keyless B TEE signer"],
  );
});
