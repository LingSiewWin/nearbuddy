// The share card's reading of a planted headline, on a real inject_chaos tx from testnet (fixtures/inject_chaos.json,
// FastNEAR /v0/transactions, the spectator bot's duel #454 attack): the call's args, the deposit, that the arena's
// receipt succeeded, and that only the exact headline whose sha256 went on chain is shown.
import { expect, test } from "bun:test";
import { plantedOf, sameText, TX_RE, type TxBody } from "../lib/card";
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
  });
  expect(TX_RE.test(tx.transaction.hash)).toBe(true);
});

test("a tx to another contract, or a refused receipt, is not a landed injection", () => {
  expect(plantedOf(tx, "someone-else.testnet")).toBeNull();
  const refused = structuredClone(tx);
  refused.receipts[0]!.execution_outcome.outcome.status = { Failure: { ActionError: {} } };
  expect(plantedOf(refused, ARENA)?.landed).toBe(false);
});

test("only the headline whose sha256 is on chain is shown", () => {
  const hash = plantedOf(tx, ARENA)!.payload_hash;
  expect(sameText(HEADLINE, hash)).toBe(true);
  expect(sameText(`${HEADLINE} `, hash)).toBe(false);
  expect(sameText("BREAKING: something else", hash)).toBe(false);
  expect(sameText(null, hash)).toBe(false);
});
