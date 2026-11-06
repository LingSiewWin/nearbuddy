"use client";
// The duel re-checked from public sources by the same checks as `bun run verify-duel <id>` (GET /api/verify, built on
// app/lib/verify.ts): every signature and enclave proof, the oracle prices, the score, the slash and the payout. For
// a resolved duel only. The first check of a duel takes 10 to 20 s; the server then keeps the result.
import { useEffect, useState } from "react";
import { Cmd } from "../../ui/cmd";

type Result = "PASS" | "FAIL" | "SKIP" | "INFO";
type Line = { result: Result; check: string; detail: string };
type Body =
  | { status: "checked"; counts: Record<Result, number>; lines: Line[]; degraded: boolean; command: string }
  | { status: "open" | "missing"; command: string }
  | { error: string };

export function Verified({ duel }: { duel: number }) {
  const [b, setB] = useState<Body | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/verify?duel=${duel}`, { signal: AbortSignal.timeout(65_000) })
      .then((r) => r.json() as Promise<Body>)
      .then((j) => alive && setB(j))
      .catch((e) => alive && setB({ error: String(e) }));
    return () => {
      alive = false;
    };
  }, [duel]);
  const command = b && "command" in b ? b.command : `bun run verify-duel ${duel}`;
  const run = (
    <>
      <p className="vrun">Run the same checks yourself, from nearbuddy/ in a checkout of the repo:</p>
      <Cmd text={command} />
    </>
  );
  if (!b)
    return (
      <li className="vrf" aria-busy="true">
        <b>Re-checking the whole duel from public sources…</b>
        <span>
          The same checks as the verify-duel script: every signature and enclave proof, both oracle prices, the score,
          the slash and the payout. The first check of a duel takes 10 to 20 seconds.
        </span>
      </li>
    );
  if (!("status" in b) || b.status !== "checked")
    return (
      <li className="vrf">
        <b>Re-check it yourself</b>
        <span>This site could not run the check just now (the transaction index is busy).</span>
        {run}
      </li>
    );
  const { PASS, FAIL, SKIP } = b.counts;
  const failed = b.lines.filter((l) => l.result === "FAIL");
  return (
    <li className={`vrf${FAIL ? " bad" : ""}`}>
      <b>
        {FAIL
          ? `${FAIL} of ${PASS + FAIL} checks failed`
          : `All ${PASS} checks pass, re-read from the chain by this site`}
      </b>
      <span>
        Every signature and enclave proof, both oracle prices, the score, the slash and the payout
        {SKIP ? `; ${SKIP} could not be checked from the chain alone` : ""}
        {b.degraded ? "; some receipts are not indexed yet, so it is checked again in a minute" : ""}.
      </span>
      {failed.length ? (
        <ul className="vlines">
          {failed.map((l) => (
            <li key={l.check} className="fail">
              <code>FAIL</code> <b>{l.check}</b> {l.detail}
            </li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>Every check ({b.lines.length})</summary>
        <ul className="vlines">
          {b.lines.map((l) => (
            <li key={`${l.result}${l.check}`} className={l.result.toLowerCase()}>
              <code>{l.result}</code> <b>{l.check}</b> {l.detail}
            </li>
          ))}
        </ul>
      </details>
      {run}
    </li>
  );
}
