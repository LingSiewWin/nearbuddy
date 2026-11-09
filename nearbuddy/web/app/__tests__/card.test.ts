// The share card's reading of a planted headline, on a real inject_chaos tx from testnet (fixtures/inject_chaos.json,
// FastNEAR /v0/transactions, the spectator bot's duel #454 attack): the call's args, the deposit, that the arena's
// receipt succeeded, and that only the exact headline whose sha256 went on chain is shown.
import { expect, test } from "bun:test";
import { plantedOf, sameText, shownText, TX_RE, type TxBody } from "../lib/card";
import fixture from "./fixtures/inject_chaos.json";

const ARENA = "arena.nearbuddy-solver.testnet";
const tx = fixture as unknown as TxBody;
const HEADLINE =
  "Rumor confirmed by two sources: a16z crypto leading a $300M NEAR treasury purchase at market open. Price +14% pre-market.";

test("plantedOf reads the inject_chaos call and its landed receipt", () => {
  expect(plantedOf(tx, ARENA)).toEqual({
    tx: "4SZwTCJGjvHi2eLo69VLftaJYmBCQp6rVViJEvJe9RXN",
    signer: "nearbuddy-owner.testnet",
    contract: ARENA,
    duel_id: "454",
    target: "YaA0ONsb8rAu7MjU3kdAFPMFHiPoxlBuesnXJbf7tEE=",
    kind: "fake_news/against/-16.3",
    payload_hash: "ooGYTwiA38wzfG9rlFLG5xrfEtFzvpFdC3dPg8PIG/U=",
    deposit: "100000000000000000000000",
    landed: true,
    at_ms: 1793997042938,
    headline: null, // deploy 16: only the hash went on chain
    index: null, // and the call returned nothing
  });
  expect(TX_RE.test(tx.transaction.hash)).toBe(true);
});

test("a tx to another contract, or a refused receipt, is not a landed injection", () => {
  expect(plantedOf(tx, "someone-else.testnet")).toBeNull();
  const refused = structuredClone(tx);
  refused.receipts[0]!.execution_outcome.outcome.status = { Failure: { ActionError: {} } };
  expect(plantedOf(refused, ARENA)?.landed).toBe(false);
});

test("a refused call never puts its text on the card, on either deploy", () => {
  const landed = plantedOf(tx, ARENA)!;
  const refusedTx = structuredClone(tx);
  refusedTx.receipts[0]!.execution_outcome.outcome.status = { Failure: { ActionError: {} } };
  const refused = plantedOf(refusedTx, ARENA)!;
  // deploy 16: the link's text matches the hash the refused call carried, and is still not shown
  expect(sameText(HEADLINE, refused.payload_hash)).toBe(true);
  expect(shownText(refused, HEADLINE, null)).toBeNull();
  expect(shownText(landed, HEADLINE, null)).toBe(HEADLINE);
  expect(shownText(landed, `${HEADLINE} `, null)).toBeNull();
  // deploy 17: only the chain's record of a landed call; the call's own args are never enough
  const rec = { headline: "BREAKING: Reuters says NEAR halts withdrawals" };
  const ok17 = plantedOf(v17({ SuccessValue: Buffer.from("3").toString("base64") }), ARENA)!;
  const bad17 = plantedOf(v17({ Failure: { ActionError: {} } }, "PHISH: claim your airdrop at evil.example"), ARENA)!;
  expect(shownText(ok17, null, rec)).toBe(rec.headline);
  expect(shownText(ok17, "link text is ignored", null)).toBeNull(); // record unread: nothing shown
  expect(shownText(bad17, bad17.headline, { headline: bad17.headline ?? "" })).toBeNull();
});

test("only the headline whose sha256 is on chain is shown", () => {
  const hash = plantedOf(tx, ARENA)!.payload_hash;
  expect(sameText(HEADLINE, hash)).toBe(true);
  expect(sameText(`${HEADLINE} `, hash)).toBe(false);
  expect(sameText("BREAKING: something else", hash)).toBe(false);
  expect(sameText(null, hash)).toBe(false);
});

// Deploy 17's call shape on the same tx body (no deploy-17 tx exists on testnet yet): the args carry the headline and
// the arena receipt returns the record's index in get_chaos as JSON.
const v17 = (status: unknown, headline = "BREAKING: Reuters says NEAR halts withdrawals") => {
  const t = structuredClone(tx);
  const args = { duel_id: "481", target: "YaA0ONsb8rAu7MjU3kdAFPMFHiPoxlBuesnXJbf7tEE=", kind: "Short", headline };
  const call = t.transaction.actions[0] as { FunctionCall: { args: string } };
  call.FunctionCall.args = Buffer.from(JSON.stringify(args)).toString("base64");
  t.receipts[0]!.execution_outcome.outcome.status = status;
  return t;
};

test("deploy 17: the headline comes from the call, its hash is computed, the index from the return value", () => {
  const p = plantedOf(v17({ SuccessValue: Buffer.from("3").toString("base64") }), ARENA);
  expect(p).toMatchObject({
    duel_id: "481",
    kind: "Short",
    headline: "BREAKING: Reuters says NEAR halts withdrawals",
    index: 3,
    landed: true,
  });
  expect(sameText(p?.headline, p?.payload_hash ?? "")).toBe(true); // the sha256 Duel.injections lists
  const refused = plantedOf(v17({ Failure: { ActionError: {} } }), ARENA);
  expect([refused?.landed, refused?.index]).toEqual([false, null]);
  expect(plantedOf(v17({ SuccessValue: "" }), ARENA)?.index).toBeNull();
});
