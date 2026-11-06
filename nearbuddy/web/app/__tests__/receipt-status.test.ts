// The receipt-status rule of the drawer's in-browser re-check. recheck() in app/ui/drawer.tsx is not exported
// (it fetches and hashes in the browser), so `status` below is a hand copy of its receipt-status lines; the
// first test fails if those lines change in drawer.tsx, so the copy cannot silently drift. What the rest
// checks is the rule against real FastNEAR transactions: a refused call's own tx status still says success.
// Run: `cd web && bun test app/__tests__`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postIntent from "./fixtures/post_intent.json";
import registerAgent from "./fixtures/register_agent.json";
import tamper from "./fixtures/tamper.json";

type Outcome = { status?: Record<string, unknown> };
type TxDetail = {
  execution_outcome?: { outcome?: Outcome };
  receipts?: { execution_outcome?: { outcome?: Outcome } }[];
};

// copy of drawer.tsx recheck(): `outcomes`, `failed`, `why` and the check's `ok`
const status = (txd: TxDetail | undefined) => {
  const outcomes: Outcome[] = [
    txd?.execution_outcome?.outcome,
    ...(txd?.receipts ?? []).map((r: { execution_outcome?: { outcome?: Outcome } }) => r.execution_outcome?.outcome),
  ].filter(Boolean) as Outcome[];
  const failed = outcomes.find((o) => o.status && "Failure" in o.status);
  const why = failed ? JSON.stringify(failed.status).match(/panicked: ([^"\\]+)/)?.[1] : null;
  return { ok: outcomes.length > 0 && !failed, why };
};

test("the copied lines are still the ones in drawer.tsx", () => {
  const src = readFileSync(join(import.meta.dir, "../ui/drawer.tsx"), "utf8");
  for (const line of [
    "txd?.execution_outcome?.outcome,",
    "...(txd?.receipts ?? []).map((r: { execution_outcome?: { outcome?: Outcome } }) => r.execution_outcome?.outcome),",
    "].filter(Boolean);",
    'const failed = outcomes.find((o) => o.status && "Failure" in o.status);',
    'const why = failed ? JSON.stringify(failed.status).match(/panicked: ([^"\\\\]+)/)?.[1] : null;',
    "ok: outcomes.length > 0 && !failed,",
  ])
    expect(src).toContain(line);
});

describe("receipt status on real transactions", () => {
  test("the tamper tx is refused with the contract's panic, though its own tx status says success", () => {
    expect(tamper.tx.execution_outcome.outcome.status).toHaveProperty("SuccessReceiptId");
    expect(status(tamper.tx as TxDetail)).toEqual({ ok: false, why: "bad tee signature" });
  });
  test("another refusal reads its own reason", () => {
    expect(status(registerAgent.tx as TxDetail)).toEqual({ ok: false, why: "agent exists" });
  });
  test("a landed post_intent: every receipt succeeded", () => {
    expect(status(postIntent.tx as TxDetail)).toEqual({ ok: true, why: null });
  });
  test("no transaction, or one with no outcomes, is not a success", () => {
    expect(status(undefined).ok).toBe(false);
    expect(status({ receipts: [] }).ok).toBe(false);
  });
});
