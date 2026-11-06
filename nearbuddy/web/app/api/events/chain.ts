// Pure readers for FastNEAR tx API bodies (POST /v0/transactions): which arena receipt opened which duel,
// with the method it was opened by. No fetch, so bun test checks them on fixture txs (app/__tests__).

/** The slice of a FastNEAR tx this file reads. Block timestamps are ns, a string or a (lossy) JSON number. */
export type Tx = {
  transaction: { hash: string };
  receipts: {
    receipt: {
      receiver_id: string;
      receipt: { Action?: { actions: ({ FunctionCall?: { method_name: string } } | string)[] } };
    };
    execution_outcome: {
      block_timestamp: string | number;
      outcome: { logs: string[]; status: { SuccessValue?: string } | Record<string, unknown> | string };
    };
  }[];
};

/** How a duel was paired: `open_duel` (owner) or `open_duel_consented` (both agent keys signed). */
export type Opened = { duel_id: string; method: string; tx: string; at_ms: number };

const OPEN_METHODS = new Set(["open_duel", "open_duel_consented"]);
const ms = (ns: string | number) => Math.floor(Number(ns) / 1e6);
const method = (r: Tx["receipts"][number]) => {
  const a = r.receipt.receipt.Action?.actions.find((x) => typeof x === "object" && x.FunctionCall);
  return typeof a === "object" ? (a.FunctionCall?.method_name ?? null) : null;
};

/** Duel opens in one tx: an arena receipt running an open method whose return value is the new duel id. */
export function opensOf(t: Tx, arena: string): Opened[] {
  return t.receipts.flatMap((r) => {
    const m = method(r);
    const st = r.execution_outcome.outcome.status;
    const v = typeof st === "object" && st && "SuccessValue" in st ? st.SuccessValue : undefined;
    if (r.receipt.receiver_id !== arena || !m || !OPEN_METHODS.has(m) || typeof v !== "string") return [];
    const id = String(JSON.parse(atob(v)) ?? "");
    return /^\d+$/.test(id)
      ? [{ duel_id: id, method: m, tx: t.transaction.hash, at_ms: ms(r.execution_outcome.block_timestamp) }]
      : [];
  });
}
