// A wallet resolves with the RPC's outcome even when the contract panicked; refusal() is what keeps the terminal from
// calling a refused inject_chaos "planted". Outcome shapes follow NEAR RPC FinalExecutionOutcome.
import { expect, test } from "bun:test";
import { refusal } from "../lib/wallet";

const panicked = (msg: string) => ({
  Failure: {
    ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } },
  },
});

test("a panicked call is a refusal with the contract's message, wherever the failure sits", () => {
  expect(
    refusal({ status: panicked("duel closed"), receipts_outcome: [{ outcome: { status: panicked("duel closed") } }] }),
  ).toBe("duel closed");
  expect(
    refusal({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: panicked("chaos full") } }] }),
  ).toBe("chaos full");
  expect(refusal({ status: { Failure: { InvalidTxError: "NotEnoughBalance" } } })).toBe(
    '{"InvalidTxError":"NotEnoughBalance"}',
  );
});

test("a call whose transaction and receipts all succeeded is no refusal", () => {
  expect(
    refusal({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessReceiptId: "x" } } }] }),
  ).toBeNull();
  expect(refusal(undefined)).toBeNull();
});
