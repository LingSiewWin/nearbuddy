"use client";
// One follower, btop-style: its vault and a pending withdrawal, what it holds from fills, its mandate per agent, the
// fills a solver settled for it, and its own calls. Read-only: every number comes from a view or a receipt that
// succeeded (GET /api/follower).
import { use, useEffect, useState } from "react";
import { activityCells, type FollowerRec, mandateCells, settledFillCells, tokenAmount, tokenName } from "../../cells";
import { addrHref, bottom, boxTitle, countdown, getJson, legend, NETWORK_ID, near, rowx } from "../../tui";

export function FollowerRecord({ params }: { params: Promise<{ account: string }> }) {
  const { account: raw } = use(params);
  const account = decodeURIComponent(raw);
  const [r, setR] = useState<FollowerRec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const j = await getJson<FollowerRec>(`/api/follower?account=${encodeURIComponent(account)}`);
        if (alive) {
          setR(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, 30_000); // the route keeps a body 30 s
    const clock = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(clock);
    };
  }, [account]);

  const model = (pk: string) => r?.mandates.find((m) => m.agent_pk === pk)?.model_id ?? null;
  const scan = r?.fills_scan;
  const fillsNote = !scan
    ? ""
    : scan.from_ms === null
      ? "no follow yet: nothing to settle"
      : scan.complete
        ? `arena txs read back to its first follow (${scan.txs} txs)`
        : `arena txs read back to ${scan.oldest_ms ? new Date(scan.oldest_ms).toISOString().slice(5, 16).replace("T", " ") : "?"} UTC only: older fills not shown`;
  const empty = (text: string) => (
    <>
      {rowx("", [{ t: r ? text : "loading", c: "dim" }])}
      {"\n"}
    </>
  );

  return (
    <>
      <pre className="wrap">
        <a href="/arena" className="dim">
          ← arena
        </a>
        {"  "}
        <span className="hi">NEARBUDDY FOLLOWER</span>{" "}
        <a href={addrHref(account)} target="_blank" rel="noreferrer">
          {account}
        </a>{" "}
        <span className="dim">· read from the contract and its txs · NEAR {NETWORK_ID}</span>
        {"\n"}
        <span className="dim">
          {r
            ? `snapshot ${new Date(r.at).toISOString()}  contract ${r.arena}${r.deploy15 ? "" : "  (before deploy 15: no holdings or delayed withdrawals)"}`
            : err
              ? `error: ${err}`
              : "connecting"}
        </span>
        <span className="cursor" />
      </pre>
      <pre>
        {boxTitle(1, "vault", "NEAR it lets the solver spend under its mandates, and fill output it holds")}
        {"\n"}
        {rowx("vault", [r ? `${near(r.vault)} NEAR` : { t: "loading", c: "dim" }])}
        {"\n"}
        {rowx(
          "withdrawal",
          !r
            ? [{ t: "-", c: "dim" }]
            : r.pending
              ? [
                  `${near(r.pending.amount)} NEAR queued   `,
                  countdown(r.pending.ready_at, now)
                    ? { t: `ready in ${countdown(r.pending.ready_at, now)}`, c: "open" }
                    : { t: "ready: withdraw() pays it", c: "ok" },
                ]
              : [{ t: "none queued", c: "dim" }],
        )}
        {"\n"}
        {(r?.holdings ?? []).map((h) => (
          <span key={h.token}>
            {rowx(`holding ${tokenName(h.token)}`, [
              { t: `${tokenAmount(h.token, h.amount)} ${tokenName(h.token)}`.padEnd(18), title: h.token },
              { t: "   credited by settled fills, withdraw_token sends it out", c: "dim" },
            ])}
            {"\n"}
          </span>
        ))}
        {legend(
          "vault = NEAR deposited, minus fills and withdrawals · withdrawal = request_withdraw, payable after the delay · holding = fill output on intents_account",
        )}
        {"\n"}
        {bottom()}
        {"\n\n"}

        {boxTitle(2, "mandates", "one per agent it follows: what the solver may spend for it")}
        {"\n"}
        {r?.mandates.length
          ? r.mandates.map((m, i) => (
              <span key={m.agent_pk}>
                {rowx(i ? "" : "agent", mandateCells(m.agent_pk, m.model_id, m.mandate, now))}
                {"\n"}
              </span>
            ))
          : empty("follows no agent")}
        {legend("cap = most NEAR per fill · spent / allowance = NEAR used of the total it allowed")}
        {"\n"}
        {bottom()}
        {"\n\n"}

        {boxTitle(3, "fills", "settled by the solver: vault NEAR in, token out")}
        {"\n"}
        {r?.fills.length
          ? r.fills.map((f, i) => (
              <span key={`${f.tx}:${f.intent_nonce}`}>
                {rowx(i ? "" : "settled", settledFillCells(f, model(f.agent_pk)))}
                {"\n"}
              </span>
            ))
          : empty("none settled")}
        {rowx("", [{ t: fillsNote, c: "dim" }])}
        {"\n"}
        {bottom()}
        {"\n\n"}

        {boxTitle(4, "activity", "its own calls that went through, newest first")}
        {"\n"}
        {r?.activity.length
          ? r.activity.map((a, i) => (
              <span key={`${a.tx}:${a.kind}`}>
                {rowx(i ? "" : "calls", activityCells(a, a.agent_pk ? model(a.agent_pk) : null))}
                {"\n"}
              </span>
            ))
          : empty("no calls to the arena")}
        {legend("only receipts that succeeded count: a refused call (an early withdraw, say) is not listed")}
        {"\n"}
        {bottom()}
      </pre>
    </>
  );
}
