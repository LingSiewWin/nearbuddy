// FastNEAR tx readers behind GET /api/events, on fixture txs shaped like POST /v0/transactions bodies
// (values from testnet duel 340, opened by open_duel). Run: `cd web && bun test app`.
import { describe, expect, test } from "bun:test";
import { eventsOf, fastnearTxApi, opensOf, type Tx } from "../api/events/chain";

describe("fastnearTxApi", () => {
  test("NEAR_NETWORK picks the host: mainnet, else testnet", () => {
    expect(fastnearTxApi("mainnet")).toBe("https://tx.main.fastnear.com/v0");
    expect(fastnearTxApi("testnet")).toBe("https://tx.test.fastnear.com/v0");
    expect(fastnearTxApi(undefined)).toBe("https://tx.test.fastnear.com/v0");
  });
});

const ARENA = "arena.nearbuddy-solver.testnet";
type R = Tx["receipts"][number];
const receipt = (
  receiver: string,
  method: string | null,
  ns: string | number,
  logs: string[] = [],
  status: R["execution_outcome"]["outcome"]["status"] = { SuccessValue: "" },
): R => ({
  receipt: {
    receiver_id: receiver,
    receipt: { Action: { actions: method ? [{ FunctionCall: { method_name: method } }] : ["Transfer"] } },
  },
  execution_outcome: { block_timestamp: ns, outcome: { logs, status } },
});
const tx = (hash: string, receipts: R[]): Tx => ({ transaction: { hash }, receipts });
const b64 = (s: string) => btoa(s);

describe("opensOf", () => {
  test("open_duel: the arena receipt's return value is the duel id", () => {
    const t = tx("952QxwJ8", [
      receipt(ARENA, "open_duel", Number("1793975553184464127"), [], { SuccessValue: "IjM0MCI=" }), // JSON number, "340"
      receipt("price-oracle.testnet", "oracle_call", "1793975554329460574"),
      receipt("nearbuddy-solver.testnet", null, "1793975554329460574"), // refund
    ]);
    expect(opensOf(t, ARENA)).toEqual([{ duel_id: "340", method: "open_duel", tx: "952QxwJ8", at_ms: 1793975553184 }]);
  });
  test("open_duel_consented is read the same way; the method is what tells them apart", () => {
    const t = tx("Cns1", [
      receipt(ARENA, "open_duel_consented", "1793975553184464127", [], { SuccessValue: b64('"412"') }),
    ]);
    expect(opensOf(t, ARENA)[0]).toMatchObject({ duel_id: "412", method: "open_duel_consented" });
  });
  test("failed opens, other methods and other receivers are not opens", () => {
    const failed = tx("F", [receipt(ARENA, "open_duel", "1", [], { Failure: { ActionError: {} } })]);
    const post = tx("P", [receipt(ARENA, "post_intent", "1", [], { SuccessValue: b64('"7"') })]);
    const elsewhere = tx("E", [receipt("other.testnet", "open_duel", "1", [], { SuccessValue: b64('"7"') })]);
    const junk = tx("J", [receipt(ARENA, "open_duel", "1", [], { SuccessValue: b64("null") })]);
    expect([failed, post, elsewhere, junk].flatMap((t) => opensOf(t, ARENA))).toEqual([]);
  });
});

const PK = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
const ev = (event: string, data: Record<string, unknown>, standard = "nearbuddy-arena") =>
  `EVENT_JSON:${JSON.stringify({ standard, version: "1.1.0", event, data })}`;

describe("eventsOf", () => {
  test("commit and reveal logs, with the emitting receipt's time and method", () => {
    const commit = tx("C1", [
      receipt(ARENA, "commit_intent", "1793975601000000000", [
        ev("commit", { duel_id: 411, agent_pk: PK, commitment: "AA==" }),
      ]),
    ]);
    const reveal = tx("R1", [
      receipt(ARENA, "reveal_intent", "1793975655500000000", [
        ev("intent", { duel_id: 411, agent_pk: PK, side: "Long", size_bps: 5000, nonce: 41, tee: 2 }),
      ]),
    ]);
    expect(eventsOf(commit, ARENA)).toEqual([
      { event: "commit", duel_id: "411", agent_pk: PK, method: "commit_intent", tx: "C1", at_ms: 1793975601000 },
    ]);
    expect(eventsOf(reveal, ARENA)[0]).toMatchObject({
      event: "intent",
      method: "reveal_intent",
      at_ms: 1793975655500,
    });
  });
  test("other events, other standards, other receivers and junk logs are skipped", () => {
    const t = tx("X", [
      receipt(ARENA, "resolve_duel", "1", [
        ev("resolve", { duel_id: 411 }),
        ev("execution_requested", { duel_id: 411, agent_pk: PK }, "near-outlayer"),
        "EVENT_JSON:{not json",
        "Resolved project: zavodil2.testnet/price-oracle",
      ]),
      receipt("other.testnet", "post_intent", "1", [ev("intent", { duel_id: 411, agent_pk: PK })]),
    ]);
    expect(eventsOf(t, ARENA)).toEqual([]);
  });
});

// Shaped like testnet tx 4rmFo38n: the tx-level status is SuccessReceiptId, yet the arena receipt panicked.
describe("a failed arena receipt never counts as landed", () => {
  const PANIC = {
    Failure: {
      ActionError: {
        index: 0,
        kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: bad tee signature" } },
      },
    },
  };
  const failed = (method: string, logs: string[], status: R["execution_outcome"]["outcome"]["status"] = PANIC) =>
    ({
      ...tx("4rmFo38nQWqUStouFr4Uqv3ZLnQ8MXe4NTNDAN9xPPSt", [
        receipt(ARENA, method, "1793975601000000000", logs, status),
        receipt("nearbuddy-solver.testnet", null, "1793975602000000000"), // gas refund, succeeds
      ]),
      execution_outcome: { outcome: { status: { SuccessReceiptId: "7g2yQLcmmWiGVxYYveYq6ubTnpWsv4ckdGbwSYQzxAi6" } } },
    }) as Tx;
  const commit = ev("commit", { duel_id: 411, agent_pk: PK, commitment: "AA==" });
  const intent = ev("intent", { duel_id: 411, agent_pk: PK, side: "Long", size_bps: 5000, nonce: 41, tee: 2 });

  test("commit, reveal and post logs from a panicked receipt are dropped", () => {
    expect(eventsOf(failed("commit_intent", [commit]), ARENA)).toEqual([]);
    expect(eventsOf(failed("reveal_intent", [intent]), ARENA)).toEqual([]);
    expect(eventsOf(failed("post_intent", [intent]), ARENA)).toEqual([]);
    // the same receipts with a successful outcome of their own do count
    expect(eventsOf(failed("reveal_intent", [intent], { SuccessValue: "" }), ARENA)).toHaveLength(1);
    expect(eventsOf(failed("commit_intent", [commit], { SuccessReceiptId: "X" }), ARENA)).toHaveLength(1);
  });
  test("a panicked open is not an open, whatever the tx-level status", () => {
    expect(opensOf(failed("open_duel_consented", []), ARENA)).toEqual([]);
    expect(opensOf(failed("open_duel_consented", [], { SuccessValue: b64('"412"') }), ARENA)).toHaveLength(1);
  });
});
