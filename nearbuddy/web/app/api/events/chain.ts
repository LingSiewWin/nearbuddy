// Pure readers for FastNEAR tx API bodies (POST /v0/transactions): which arena receipt opened which duel,
// with the method it was opened by, and the contract's `commit` / `intent` EVENT_JSON logs with the method
// that emitted them. No fetch, so bun test checks them on fixture txs (app/__tests__).
import type { ChainEvent, Opened } from "../../cells";

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

const OPEN_METHODS = new Set(["open_duel", "open_duel_consented"]);
/** The receipt's own outcome succeeded. The tx-level status is never read: FastNEAR reports SuccessReceiptId
 *  there even when the arena receipt panicked (tx 4rmFo38n, "bad tee signature"). */
const succeeded = (r: Tx["receipts"][number]) => {
  const st = r.execution_outcome.outcome.status;
  return typeof st === "object" && st !== null && ("SuccessValue" in st || "SuccessReceiptId" in st);
};
const ms = (ns: string | number) => Math.floor(Number(ns) / 1e6);
const method = (r: Tx["receipts"][number]) => {
  const a = r.receipt.receipt.Action?.actions.find((x) => typeof x === "object" && x.FunctionCall);
  return typeof a === "object" ? (a.FunctionCall?.method_name ?? null) : null;
};

/** Duel opens in one tx: an arena receipt running an open method whose own outcome is a SuccessValue holding the
 *  new duel id (a failed receipt has no SuccessValue, whatever the tx-level status says). */
export function opensOf(t: Tx, arena: string): Opened[] {
  return t.receipts.flatMap((r) => {
    const m = method(r);
    const st = r.execution_outcome.outcome.status;
    const v = typeof st === "object" && st && "SuccessValue" in st ? st.SuccessValue : undefined;
    if (r.receipt.receiver_id !== arena || !m || !OPEN_METHODS.has(m) || typeof v !== "string") return [];
    let id = "";
    try {
      id = String(JSON.parse(atob(v)) ?? "");
    } catch {} // not a JSON duel id: not an open
    return /^\d+$/.test(id)
      ? [{ duel_id: id, method: m, tx: t.transaction.hash, at_ms: ms(r.execution_outcome.block_timestamp) }]
      : [];
  });
}

/** The arena's `commit` and `intent` events in one tx, each with its emitting receipt's block time and method
 *  (`reveal_intent` vs `post_intent` tells a reveal from an intent posted in the clear). */
export function eventsOf(t: Tx, arena: string): ChainEvent[] {
  return t.receipts.flatMap((r) =>
    r.receipt.receiver_id !== arena || !succeeded(r) // a failed receipt's logs never landed
      ? []
      : r.execution_outcome.outcome.logs.flatMap((log): ChainEvent[] => {
          if (!log.startsWith("EVENT_JSON:")) return [];
          let e: { standard?: string; event?: string; data?: { duel_id?: number | string; agent_pk?: string } };
          try {
            e = JSON.parse(log.slice("EVENT_JSON:".length));
          } catch {
            return [];
          }
          if (e.standard !== "nearbuddy-arena" || (e.event !== "commit" && e.event !== "intent")) return [];
          if (e.data?.duel_id == null || !e.data.agent_pk) return [];
          return [
            {
              event: e.event,
              duel_id: String(e.data.duel_id),
              agent_pk: e.data.agent_pk,
              method: method(r) ?? "",
              tx: t.transaction.hash,
              at_ms: ms(r.execution_outcome.block_timestamp),
            },
          ];
        }),
  );
}
