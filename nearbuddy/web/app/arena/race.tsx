"use client";
// The story at the top: one sentence on who is winning and what it costs, the clock, and the race card (the
// reference price over the duel window with each model's calls as lanes underneath and attacks as flags).
import type { ArenaEvent } from "../api/tape";
import type { Tick } from "../lib/live";
import { agentHref, closedAgo, mmss, near, pct, sideWord, stake, tone, usd, who } from "../ui/format";
import { type Attack, duelEvents, type Focus, type Intent, markPct, openOf } from "./model";

const sideTone = (f: Focus) => {
  const a = tone(f.a.model);
  const b = tone(f.b.model);
  return { a, b: b === a ? "k-alt" : b };
};

/** "is betting up", "has sealed a call (it opens in the last minute)" or "is yet to make a call". */
const doing = (s: Focus["a"]) =>
  s.side ? (
    <>
      is <b>{sideWord(s.side)}</b>
    </>
  ) : s.sealed ? (
    <>
      has <b>sealed a call</b> that opens in the last minute
    </>
  ) : (
    <>
      is <b>yet to make a call</b>
    </>
  );

export function Headline({
  f,
  price,
  open,
  now,
  attack = null,
  answer = null,
}: {
  f: Focus;
  price: number | null;
  open: number | null;
  now: number;
  /** the newest paid attack in this live duel, from the tape */
  attack?: Attack | null;
  /** the target's first call sealed (or made) after that attack: its answer to the lie, if any yet */
  answer?: Intent | null;
}) {
  const t = sideTone(f);
  const A = <span className={`who ${t.a}`}>{who(f.a.model)}</span>;
  const B = <span className={`who ${t.b}`}>{who(f.b.model)}</span>;
  const left = Math.max(0, Math.round((f.closes - now) / 1000));
  const span = Math.max(1, (f.closes - f.opened) / 1000);
  const p = f.live ? price : f.close;
  const ma = f.live ? markPct(f.a, open, p) : (f.a.return_pct ?? 0);
  const mb = f.live ? markPct(f.b, open, p) : (f.b.return_pct ?? 0);
  const move = open && p ? ((p - open) / open) * 100 : 0;
  const lead = Math.abs(ma - mb) < 0.005 ? null : ma > mb ? "a" : "b";
  const loser = lead === "a" ? f.b : lead === "b" ? f.a : null;
  const pay = loser?.bond != null ? (loser.bond * f.slashPct) / 100 : null;

  let h1: React.ReactNode;
  let sub: React.ReactNode;
  if (f.live && now && now > f.closes) {
    // the bell has rung and resolve_duel has not landed yet (it usually does within seconds)
    h1 = "Waiting for the closing price.";
    sub = (
      <>
        Duel {f.duel} {closedAgo(now - f.closes)} and is waiting to be scored. Anyone can trigger that on chain; the TEE
        oracle supplies the closing price. At the last trade,{" "}
        {lead ? (
          <>{lead === "a" ? A : B} was ahead</>
        ) : f.a.side || f.b.side ? (
          "the two sides were tied"
        ) : (
          "neither side had revealed a call"
        )}
        .
      </>
    );
  } else if (f.live && (price == null || !open)) {
    // no trade yet (the server's first frame, or the Coinbase feed is down): nobody can be called ahead
    h1 = `Duel ${f.duel} is on.`;
    sub = (
      <>
        {A} {doing(f.a)}, {B} {doing(f.b)}. Waiting for the live NEAR price to show who is ahead.
      </>
    );
  } else if (f.live) {
    // "Dead heat" only once a side is known; before the first reveal nothing can be level or ahead
    h1 = lead ? (
      <>{lead === "a" ? A : B} is winning.</>
    ) : f.a.side && f.a.side === f.b.side ? (
      // the common case: both made the same call, so the price cannot separate them
      `Both bet ${f.a.side === "Long" ? "up" : "down"}.`
    ) : f.a.side || f.b.side ? (
      "Dead heat."
    ) : f.a.sealed && f.b.sealed ? (
      // commit-reveal: both have called, and nobody can read either call until the last minute
      "Both calls are sealed."
    ) : (
      `Duel ${f.duel}: no call revealed yet.`
    );
    sub = (
      <>
        {A} {doing(f.a)}, {B} {doing(f.b)}, and NEAR is{" "}
        <b>
          {move >= 0 ? "up" : "down"} {Math.abs(move).toFixed(2)}%
        </b>{" "}
        on Coinbase since the duel opened.{" "}
        {lead && loser ? (
          <>
            If it ends now, {lead === "a" ? B : A} pays {lead === "a" ? A : B}{" "}
            <b>{pay != null ? near(pay) : `${f.slashPct}% of its bond`}</b>
            {f.pot > 0 ? <> plus the {near(f.pot)} pot</> : null}.
          </>
        ) : f.a.side && f.a.side === f.b.side ? (
          "Same call on both sides: if it ends like this, nobody pays."
        ) : (
          "Nobody is ahead yet."
        )}
      </>
    );
  } else {
    const w = f.winner === f.a.agent ? "a" : f.winner === f.b.agent ? "b" : null;
    h1 = w ? (
      <>
        {w === "a" ? A : B} won duel {f.duel}.
      </>
    ) : (
      `Duel ${f.duel} ended in a tie.`
    );
    sub = w ? (
      <>
        {w === "a" ? B : A} paid <b>{near(f.slashed)}</b> of its bond. NEAR moved <b>{pct(move)}</b> between the
        oracle&apos;s open and close. The next duel usually opens within a minute.
      </>
    ) : (
      <>Both ended with the same score, so nobody paid. The next duel usually opens within a minute.</>
    );
  }
  // the duel's newest paid lie, said in the hero so a newcomer sees the point of the page while it plays out
  // (skipped before the clock starts: `now` is 0 on the first render)
  if (f.live && attack && now) {
    const hitA = attack.target === f.a.agent;
    const target = hitA ? f.a : f.b;
    const closed = now > f.closes; // no reveal can land after the close
    const ago = Math.max(0, Math.round((now - attack.at) / 1000));
    const chars = Array.from(attack.text ?? ""); // by code point, so an emoji is never cut in half
    const text = attack.text && chars.length > 80 ? `${chars.slice(0, 78).join("")}…` : attack.text;
    sub = (
      <>
        {sub}{" "}
        <span className="lie-now">
          {hitA ? A : B} was fed a paid fake headline {ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago
          {text ? <>: “{text}”</> : ""}.{" "}
          {answer
            ? `Its answer: ${sideWord(answer.side)}.`
            : closed
              ? target.sealed
                ? "Its answer was sealed and never revealed."
                : "It made no call after it."
              : target.sealed
                ? "Its next call is sealed until the last minute."
                : "It has not answered yet."}
        </span>
      </>
    );
  }
  return (
    <div className="head">
      <div>
        <h1>{h1}</h1>
        <p className="sub">{sub}</p>
        {f.live ? (
          <details className="fine">
            <summary>The live line is Coinbase; the score is the oracle&apos;s. How it is scored</summary>
            Live line: Coinbase NEAR-USD trades. The score is set by the TEE price oracle at the open and the close; its
            prices can be up to five minutes old, so the final score can differ from the live line.
            {f.open && open && Math.abs(f.open - open) / open >= 0.0001
              ? ` This duel's oracle open is ${usd(f.open)}, ${Math.abs(((f.open - open) / open) * 100).toFixed(2)}% ${f.open > open ? "above" : "below"} Coinbase's first trade after the open.`
              : ""}
            {f.sealed
              ? ` Calls are sealed until revealed, so nobody can copy them in time; a side that never reveals forfeits ${f.forfeitPct}% of its bond.`
              : ""}
            {f.consent ? " Both agents agreed to this pairing." : ""}
          </details>
        ) : null}
      </div>
      <div className="clock">
        <span className="cd">{f.live ? (now ? mmss(left) : "–:––") : "0:00"}</span>
        <small>
          {f.live
            ? left > 0
              ? `left in duel ${f.duel}`
              : "duel closed, waiting for the oracle"
            : `duel ${f.duel} closed`}
        </small>
        <div className="prog">
          <i style={{ width: `${f.live ? Math.min(100, ((span - left) / span) * 100) : 100}%` }} />
        </div>
      </div>
    </div>
  );
}

export function Race({ f, ticks, events, now }: { f: Focus; ticks: Tick[]; events: ArenaEvent[]; now: number }) {
  const t0 = f.opened;
  const t1 = f.closes;
  const end = f.live ? Math.min(now || t0, t1) : t1;
  const x = (t: number) => Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) * 100;
  const win = ticks.filter((k) => k.t >= t0 - 2_000 && k.t <= end);
  const open = openOf(f, ticks);
  const oracleOpen = f.open ?? open; // the dashed line is the oracle's open when it has one
  const vals = win.map((k) => k.p).concat(open ? [open] : [], oracleOpen ? [oracleOpen] : []);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.15, (open ?? 1) * 0.0004);
  const y = (p: number) => (1 - (p - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  const d = win.map((k, i) => `${i ? "L" : "M"}${(x(k.t) * 10).toFixed(1)},${y(k.p).toFixed(2)}`).join("");
  const last = win.at(-1);
  const price = f.live ? (last?.p ?? null) : f.close;
  const move = open && price ? ((price - open) / open) * 100 : null;
  const { intents, attacks } = duelEvents(events, f.duel);
  // the chart's numbers in words, for screen readers
  const label = `NEAR price over duel ${f.duel}${open ? `, open ${usd(open)}` : ""}${
    price != null && move != null
      ? `, ${f.live ? "now" : "close"} ${usd(price)}, ${move >= 0 ? "up" : "down"} ${Math.abs(move).toFixed(2)}%`
      : ", no trades yet"
  }${attacks.length ? `, ${attacks.length} paid attack${attacks.length > 1 ? "s" : ""}` : ""}`;
  const t = sideTone(f);
  const lockX = x(t1 - f.lockS * 1000);
  const lane = (s: Focus["a"], k: string) => {
    const mine = intents.filter((i) => i.agent === s.agent);
    const score = (x: Focus["a"]) => (f.live ? markPct(x, open, price) : (x.return_pct ?? 0));
    const mark = score(s);
    const other = score(s === f.a ? f.b : f.a);
    return (
      <>
        <div className={`lab llab ${k}`}>
          <a className="n who" href={agentHref(s.agent)}>
            {who(s.model)}
          </a>
          <span className="s">
            {s.side ?? (s.sealed ? "Sealed call" : "No call yet")}
            {s.side ? `, ${stake(s.size_pct)}` : ""}
          </span>
          <span className="st">
            {!s.side && !(s === f.a ? f.b : f.a).side
              ? s.sealed
                ? "hidden until revealed"
                : "no call yet"
              : Math.abs(mark - other) < 0.005
                ? "tied"
                : mark > other
                  ? "ahead"
                  : "behind"}
          </span>
        </div>
        <div className={`trk lane ${k}`}>
          <div className="rail">
            {mine.map((i, n) => {
              const from = x(i.at);
              const to = x(mine[n + 1]?.at ?? end);
              const w = Math.max(0.6, to - from);
              return (
                <div
                  key={i.tx}
                  className={`seg ${i.side === "Long" ? "long" : "short"}`}
                  style={{ left: `${from}%`, width: `${w}%` }}
                  title={`${i.side} ${i.size / 100}%`}
                >
                  {w > 5 ? <span>{i.side}</span> : null}
                </div>
              );
            })}
            {attacks
              .filter((a) => a.target === s.agent)
              .map((a) => (
                <i key={a.tx} className="hit" style={{ left: `${x(a.at)}%` }} title="paid attack" />
              ))}
            {!mine.length ? <span className="empty">calls appear here as they land on chain</span> : null}
          </div>
        </div>
      </>
    );
  };
  return (
    <div className="race">
      <div className="lab plab">
        <div className="p">{usd(price)}</div>
        <div className="d">
          {move == null
            ? "waiting for trades"
            : `${move >= 0 ? "up" : "down"} ${Math.abs(move).toFixed(2)}% on Coinbase since the duel opened`}
        </div>
      </div>
      <div className="trk chart">
        {f.live ? <div className="future" style={{ left: `${x(end)}%` }} /> : null}
        {f.live && f.lockS ? (
          <div className="locked" style={{ left: `${lockX}%` }}>
            <span>calls locked</span>
          </div>
        ) : null}
        <div className="plot">
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={label}>
            {open ? (
              <line
                x1="0"
                x2="1000"
                y1={y(oracleOpen ?? open)}
                y2={y(oracleOpen ?? open)}
                stroke="var(--faint)"
                strokeDasharray="4 5"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <path
              d={d}
              fill="none"
              stroke="var(--ink)"
              strokeWidth="1.6"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
          {open ? (
            <span className="openlab" style={{ top: `${y(oracleOpen ?? open)}%` }}>
              {f.open ? "oracle open" : "open"} {usd(oracleOpen ?? open)}
            </span>
          ) : null}
          {last ? <i className="dot" style={{ left: `${x(last.t)}%`, top: `${y(last.p)}%` }} /> : null}
        </div>
        {attacks.map((a) => {
          const k = a.target === f.a.agent ? t.a : t.b;
          return (
            <div key={a.tx} className={`flag ${x(a.at) > 70 ? "right" : ""} ${k}`} style={{ left: `${x(a.at)}%` }}>
              <span>Attack on {who(a.target === f.a.agent ? f.a.model : f.b.model)}</span>
            </div>
          );
        })}
        <div className="axis">
          <span>open</span>
          <span>close</span>
        </div>
      </div>
      {lane(f.a, t.a)}
      {lane(f.b, t.b)}
    </div>
  );
}
