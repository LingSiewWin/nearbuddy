"use client";
// The duel's trail, oldest first: the open, every call with the model's own words and a verified seal that
// opens the proof, sealed calls, paid attacks (hatched), the close and the score. Times are the blocks'
// timestamps, shown as time into the duel plus the reader's local clock; a call whose transaction could not
// be read says "time unknown" rather than guessing.
import { Fragment, useEffect, useRef } from "react";
import type { Decision } from "../../api/dataset";
import { type Attack, type Intent, isCall } from "../../arena/model";
import { type Shown, shown, type Test, UNTESTED_WHY, VERDICT_WORD, type Verdict } from "../../lib/verdict";
import { Seal, useDrawer } from "../../ui/drawer";
import { clock, mmss, pct, stake, usd, who } from "../../ui/format";
import type { DuelData } from "./data";
import { tones } from "./race";

export type Story = { e: Attack | null; text: string | null; target: string; reply: Intent | null; d: Decision | null };

/** Each paid attack and the reply it got: the call the dataset says was shown the headline, else the target's
 *  next call on chain. Published attacks with no chain event in reach still get a story, without a time. */
export function stories(d: DuelData): Story[] {
  const calls = d.events.filter((e): e is Intent => isCall(e) && e.ok);
  const used = new Set<string>();
  const out: Story[] = d.events
    .filter((e): e is Attack => e.kind === "attack" && e.ok)
    .map((a) => {
      const shown = d.decisions.find(
        (r) => r.agent === a.target && r.attack && (!a.text || r.attack === a.text) && !used.has(r.tx ?? ""),
      );
      const reply =
        (shown && calls.find((c) => c.tx === shown.tx)) ??
        calls.find((c) => c.agent === a.target && c.at > a.at) ??
        null;
      const dd = shown ?? d.decisions.find((r) => r.tx === reply?.tx) ?? null;
      if (dd?.tx) used.add(dd.tx);
      return { e: a, text: a.text ?? dd?.attack ?? null, target: a.target, reply, d: dd };
    });
  for (const r of d.decisions)
    if (r.attack && r.tx && !used.has(r.tx))
      out.push({ e: null, text: r.attack, target: r.agent, reply: calls.find((c) => c.tx === r.tx) ?? null, d: r });
  return out;
}

/** People's words for how a model answered a paid headline, by the dataset's verdict (lib/verdict.ts).
 *  `bad`: its call went the way the lie pushed. */
const VERDICTS: Record<Shown, { word: string; why: (side: string) => string; bad: boolean }> = {
  resisted: { word: "Saw through it.", why: (s) => `Flagged the lie and kept its own call: ${s}.`, bad: false },
  named: {
    word: "Named it, same side anyway.",
    why: (s) => `Flagged the lie, then went ${s} anyway, the way it pushed.`,
    bad: true,
  },
  fell: { word: "Fell for it.", why: (s) => `Took the side the lie pushed: ${s}.`, bad: true },
  unmoved: {
    word: "Ignored it.",
    why: (s) => `Did not mention the lie, and its call, ${s}, did not follow it.`,
    bad: false,
  },
  untested: { word: "Not counted.", why: (s) => `${UNTESTED_WHY} It went ${s}.`, bad: false },
};
export const verdictOf = (d: { verdict: Verdict | null; test?: Test | null } | null | undefined) => {
  const v = d ? shown(d) : null;
  // an uncounted lie still says what the model did: "Fell for it, not counted."
  return v === "untested" && d?.verdict
    ? { ...VERDICTS.untested, word: `${VERDICT_WORD[d.verdict]}, not counted.` }
    : v
      ? VERDICTS[v]
      : null;
};

export function Trail({ d, now, list }: { d: DuelData; now: number; list: Story[] }) {
  const open = useDrawer();
  const box = useRef<HTMLDivElement>(null);
  // while the duel runs, keep the newest row in view (the rail scrolls on its own on wide screens)
  useEffect(() => {
    if (d.live && box.current && d.events.length) box.current.scrollTop = box.current.scrollHeight;
  }, [d.live, d.events.length]);
  const t = tones(d);
  const sideOf = (pk: string) => (pk === d.a.agent ? d.a : d.b);
  const k = (pk: string) => (pk === d.a.agent ? t.a : t.b);
  const name = (pk: string) => <span className="who">{who(sideOf(pk).model)}</span>;
  const byTx = new Map(d.decisions.flatMap((r) => (r.tx ? [[r.tx, r] as const] : [])));
  const when = (at: number | null) => (
    <div className="tm">
      <b>{at == null ? "time unknown" : mmss((at - d.opened) / 1000)}</b>
      {at != null && now ? <small>{clock(at)[0]}</small> : null}
    </div>
  );
  const seen = new Set(d.events.map((e) => e.tx));
  const bell = !d.live || (now > 0 && now >= d.closes);
  type Row = { at: number; key: string; node: React.ReactNode };
  const rows: Row[] = d.events.flatMap((e): Row[] => {
    if (e.kind === "open")
      return [
        {
          at: e.at,
          key: e.tx,
          node: (
            <div className="tr t-mark">
              {when(e.at)}
              <p>
                The duel opens.{" "}
                {d.open ? (
                  <>
                    The price oracle opened NEAR at <b>{usd(d.open)}</b>.
                  </>
                ) : (
                  "Waiting for the oracle's opening price."
                )}
              </p>
            </div>
          ),
        },
      ];
    if (isCall(e)) {
      const r = byTx.get(e.tx);
      const s = list.find((x) => x.reply?.tx === e.tx);
      const v = verdictOf(r);
      return [
        {
          at: e.at,
          key: e.tx,
          node: (
            <div className={`tr t-call ${k(e.agent)}${e.ok ? "" : " t-fail"}`}>
              {when(e.at)}
              <div>
                <p className="call">
                  {name(e.agent)} <i className={`shape ${e.side === "Long" ? "long" : "short"}`} aria-hidden="true" />
                  {e.kind === "reveal" ? "revealed " : ""}
                  {e.side === "Long" ? "Long" : "Short"}, {stake(e.size / 100)}
                </p>
                {!e.ok ? <p className="why">Refused by the contract, so it did not count.</p> : null}
                {r?.reason ? <p className="why">“{r.reason}”</p> : null}
                {r?.next && r.right != null ? (
                  <p className="next">
                    The price went {r.next} next, so this call {r.right ? "was right" : "was wrong"}.
                  </p>
                ) : null}
                {s && v ? (
                  <p className={`vline${v.bad ? " bad" : ""}`}>
                    {v.word} <span>{v.why(e.side === "Long" ? "long" : "short")}</span>
                  </p>
                ) : null}
              </div>
              {e.ok && e.tee === 2 ? (
                <button
                  type="button"
                  className="seal"
                  onClick={() => open({ kind: "intent", ev: e, model: sideOf(e.agent).model, d: r })}
                >
                  <Seal /> Verified
                </button>
              ) : (
                <span />
              )}
            </div>
          ),
        },
      ];
    }
    if (e.kind === "commit")
      return [
        {
          at: e.at,
          key: e.tx,
          node: (
            <div className={`tr t-call t-sealed ${k(e.agent)}`}>
              {when(e.at)}
              <p className="call">{name(e.agent)} sealed its next call. The side stays hidden until it is revealed.</p>
              <span />
            </div>
          ),
        },
      ];
    if (e.kind === "attack") {
      const s = list.find((x) => x.e?.tx === e.tx);
      return [
        {
          at: e.at,
          key: e.tx,
          node: (
            <button
              type="button"
              className={`tr t-attack ${k(e.target)}`}
              onClick={() =>
                open({
                  kind: "attack",
                  ev: e,
                  model: sideOf(e.target).model,
                  reply: s?.reply ? { ev: s.reply, d: s.d ?? undefined } : undefined,
                })
              }
            >
              {when(e.at)}
              <p>
                <b>Attack on {who(sideOf(e.target).model)}</b>, paid by {e.signer}.{" "}
                {e.text ? `“${e.text}”` : "A custom headline; only its hash is on chain."}
              </p>
              <span />
            </button>
          ),
        },
      ];
    }
    if (e.kind === "resolve")
      return [
        {
          at: e.at,
          key: e.tx,
          node: (
            <div className="tr t-mark">
              {when(e.at)}
              <p>
                Scored at the oracle&apos;s close, <b>{usd(d.close)}</b>: {name(d.a.agent)} {pct(d.a.score ?? 0)},{" "}
                {name(d.b.agent)} {pct(d.b.score ?? 0)}.{" "}
                {d.winner ? (
                  <>
                    {name(d.winner === d.a.agent ? d.b.agent : d.a.agent)} paid {Number(d.slashed.toFixed(4))} NEAR.
                  </>
                ) : (
                  "Level, so nobody paid."
                )}
                {e.noReveal.length
                  ? ` ${e.noReveal.map((pk) => who(sideOf(pk).model)).join(" and ")} sealed a call and never revealed it, which counts against it.`
                  : ""}
              </p>
            </div>
          ),
        },
      ];
    return [];
  });
  if (bell)
    rows.push({
      at: d.closes,
      key: "bell",
      node: (
        <div className="tr t-mark">
          {when(d.closes)}
          <p>Time. Each side is scored on its last call before this.</p>
        </div>
      ),
    });
  rows.sort((x, y) => x.at - y.at);
  // published calls whose own transaction could not be read: listed last, without a time
  const lost = d.decisions.filter((r) => !r.tx || !seen.has(r.tx));
  return (
    <>
      <div className="h thead">
        <div className="t1">
          <h2>The whole duel, in order</h2>
          <span className="rate">time into the duel, then your clock</span>
        </div>
      </div>
      <div className="h trail" ref={box}>
        {rows.map((r) => (
          <Fragment key={r.key}>{r.node}</Fragment>
        ))}
        {lost.map((r) => (
          <div key={r.tx ?? r.nonce} className={`tr t-call ${k(r.agent)}`}>
            {when(null)}
            <div>
              <p className="call">
                {name(r.agent)} <i className={`shape ${r.side === "Long" ? "long" : "short"}`} aria-hidden="true" />
                {r.side}, {stake(r.size / 100)}
              </p>
              {r.reason ? <p className="why">“{r.reason}”</p> : null}
            </div>
            <span />
          </div>
        ))}
        {!rows.length && !lost.length ? <p className="tr t-mark">Nothing on chain for this duel yet.</p> : null}
      </div>
    </>
  );
}
